/**
 * vivaldi-smoke.js — Smoke test in the REAL Vivaldi on Windows, driven from WSL.
 *
 * Purpose: prove the extension works in Vivaldi itself (not just Playwright's Chromium) without
 * touching your normal profile:
 *  1. copies extension/ to a temporary Windows folder,
 *  2. serves test/e2e/fixtures/smoke.html from WSL (Windows reaches it via localhost forwarding),
 *  3. starts vivaldi.exe with a throwaway --user-data-dir, --load-extension and that page
 *     (headless by default; WR_SMOKE_HEADED=1 shows a window),
 *  4. the page POSTs what it sees to /report; the result is compared with the expected text,
 *  5. stops only that Vivaldi instance (by PID) and deletes the temporary folder.
 *
 * Usage: npm run test:vivaldi      (env: VIVALDI_EXE=/mnt/c/.../vivaldi.exe to override)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const H = require('../e2e/harness.js');

const EXPECTED = {
  h1: 'A1 check',
  p: 'B2 A1 A1S',
  title: 'A1 smoke – B2',
  editor: 'apple editor',
  placeholder: 'A1 here',
  closedShadow: 'A1 in closed shadow',
  iframe: 'A1 in frame',
  dynamic: 'dynamic A1',
};
const TIMEOUT_MS = 45000;

/** Runs a PowerShell command on Windows and returns its stdout. */
function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: '/mnt/c',
    encoding: 'utf8',
  }).trim();
}

/** Converts a WSL path to a Windows path. */
const toWin = (p) => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();

/** Finds vivaldi.exe (env override, per-user install, system install). */
function findVivaldi(localAppData) {
  const candidates = [
    process.env.VIVALDI_EXE,
    path.join(localAppData, 'Vivaldi', 'Application', 'vivaldi.exe'),
    '/mnt/c/Program Files/Vivaldi/Application/vivaldi.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`vivaldi.exe not found (tried: ${candidates.join(', ')})`);
  return found;
}

/** PIDs of Vivaldi browser processes started with our unique profile folder. */
function smokePids(marker) {
  const out = powershell(
    `Get-CimInstance Win32_Process -Filter "Name='vivaldi.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*--type=*' } | ` +
      `ForEach-Object { $_.ProcessId }`
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/**
 * Pre-seeds the throwaway profile so Vivaldi skips its first-run welcome/onboarding (which
 * otherwise keeps the start URL from opening) and has developer mode on.
 */
function seedProfile(profileDir, vivaldiExe) {
  const versionDir = fs.readdirSync(path.dirname(vivaldiExe)).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)) || '';
  const prefs = {
    browser: { check_default_browser: false, has_seen_welcome_page: true },
    extensions: { ui: { developer_mode: true } },
    vivaldi: {
      startup: {
        check_is_default: false,
        has_seen_welcome_page: true,
        has_seen_feature: 1,
        first_seen_version: versionDir,
        last_seen_version: versionDir,
        last_seen_search_engine_prompt_version: 99,
        last_seen_search_engine_prompt_time: Date.now() / 1000,
      },
      welcome: { read_pages: [] },
    },
  };
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify(prefs));
  fs.writeFileSync(path.join(profileDir, 'First Run'), '');
}

/** Main flow; returns the process exit code. */
async function main() {
  const localAppData = execFileSync('wslpath', ['-u', powershell('$env:LOCALAPPDATA')], { encoding: 'utf8' }).trim();
  const vivaldi = findVivaldi(localAppData);
  const marker = `wr-vivaldi-smoke-${Date.now()}`;
  const tempDir = path.join(localAppData, 'Temp', marker);
  const extDir = path.join(tempDir, 'extension');
  const profileDir = path.join(tempDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  seedProfile(profileDir, vivaldi);
  fs.cpSync(H.EXT_DIR, extDir, { recursive: true });
  // The shipped example rules are switched off: give the test copy its own word list.
  fs.writeFileSync(path.join(extDir, 'rules.json'), JSON.stringify({ apple: 'A1', banana: 'B2' }));

  const reports = [];
  const srv = await H.startServer({ host: '0.0.0.0', reports });
  const url = `http://localhost:${srv.port}/smoke.html`;
  const args = [
    `--user-data-dir=${toWin(profileDir)}`,
    `--load-extension=${toWin(extDir)}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.env.WR_SMOKE_HEADED ? [] : ['--headless=new']),
    url,
  ];
  console.log(`Vivaldi: ${vivaldi}\nPage:    ${url}\nProfile: ${toWin(profileDir)} (temporary)`);
  const child = spawn(vivaldi, args, { stdio: 'ignore', detached: false });
  child.on('error', (e) => reports.push({ launchError: e.message }));

  let exitCode = 1;
  try {
    await H.waitFor(() => reports.length > 0, { timeout: TIMEOUT_MS, interval: 250, message: 'no report from the page' });
    const report = reports[0];
    console.log('Report from Vivaldi:', JSON.stringify(report, null, 2));
    const failures = Object.entries(EXPECTED).filter(([k, v]) => report[k] !== v);
    if (failures.length === 0) {
      console.log('✔ Vivaldi smoke test passed: all checks match.');
      exitCode = 0;
    } else {
      for (const [k, v] of failures) console.log(`✖ ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(report[k])}`);
    }
  } catch (e) {
    console.log(`✖ ${e.message} — Vivaldi may ignore --load-extension; check manually (see README).`);
  } finally {
    for (const pid of smokePids(marker)) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch (_) {
        /* already gone */
      }
    }
    child.kill();
    await srv.close();
    await new Promise((r) => setTimeout(r, 1500)); // let Windows release file locks
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`smoke test failed to run: ${e.message}`);
    process.exit(1);
  }
);
