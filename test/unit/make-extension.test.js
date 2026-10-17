/**
 * make-extension.test.js — Tests for make-extension-ubuntu.sh and make-extension-windows.cmd/.ps1.
 *
 * Purpose: both scripts must (1) build word-replacer-extension.zip with the extension files at its
 * root, (2) extract it into <out>/word-replacer identical to extension/ (+ marker file),
 * (3) replace their own previous output cleanly, and (4) refuse to delete a folder they did not
 * create or one that overlaps the source. They run on a temporary copy of the project, never on
 * the real folders. The Windows part runs only where Windows PowerShell is reachable (WSL).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension');
const MARKER = 'DEPLOYED-BY-WORD-REPLACER.txt';

/** Lists files below dir as sorted relative paths with forward slashes. */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** CRC-32 (to verify ZIP entries). */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Minimal ZIP reader (central directory) returning [{name, data, crc}]. */
function readZip(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory found');
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    entries.push({ name, crc, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

/** Asserts that <out> holds a correct ZIP and an extracted folder identical to extension/. */
function assertOutput(out) {
  const files = listFiles(EXT);
  const entries = readZip(path.join(out, 'word-replacer-extension.zip'));
  assert.deepEqual(entries.map((e) => e.name).sort(), files, 'ZIP: same files, at the root, "/" separators');
  for (const e of entries) {
    const original = fs.readFileSync(path.join(EXT, e.name));
    assert.ok(e.data.equals(original), `ZIP: ${e.name} content`);
    assert.equal(e.crc, crc32(original), `ZIP: ${e.name} CRC`);
  }
  const target = path.join(out, 'word-replacer');
  assert.deepEqual(listFiles(target), [...files, MARKER].sort(), 'extracted folder = extension/ + marker');
  for (const f of files) assert.ok(fs.readFileSync(path.join(target, f)).equals(fs.readFileSync(path.join(EXT, f))), f);
}

/** Temporary copy of the project layout the scripts expect (scripts + extension/). */
function projectCopy(base) {
  const dir = fs.mkdtempSync(path.join(base, 'wr-proj-'));
  fs.cpSync(EXT, path.join(dir, 'extension'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'make-extension-ubuntu.sh'), path.join(dir, 'make-extension-ubuntu.sh'));
  fs.copyFileSync(path.join(ROOT, 'make-extension-windows.cmd'), path.join(dir, 'make-extension-windows.cmd'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'make-extension-windows.ps1'), path.join(dir, 'scripts', 'make-extension-windows.ps1'));
  return dir;
}

// ---------------------------------------------------------------------------------------------
// Ubuntu
// ---------------------------------------------------------------------------------------------

/** Runs the Ubuntu script of a project copy with an explicit output folder. */
function runUbuntu(project, out) {
  return spawnSync('bash', [path.join(project, 'make-extension-ubuntu.sh'), out], {
    encoding: 'utf8',
    env: { ...process.env, WR_NO_CLIPBOARD: '1' },
  });
}

test('Ubuntu script: builds the ZIP + extension folder and shows where they are', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-mk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = projectCopy(tmp);
  const out = path.join(tmp, 'out');
  const r = runUbuntu(project, out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ZIP file .*word-replacer-extension\.zip/);
  assert.match(r.stdout, /Extension folder .*word-replacer/);
  assertOutput(out);

  fs.writeFileSync(path.join(out, 'word-replacer', 'stale.txt'), 'old');
  const again = runUbuntu(project, out);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.existsSync(path.join(out, 'word-replacer', 'stale.txt')), false, 're-run gives a clean copy');
  assertOutput(out);
});

test('Ubuntu script: refuses a folder it did not make, and output overlapping the source', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-mk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = projectCopy(tmp);
  const out = path.join(tmp, 'out');
  fs.mkdirSync(path.join(out, 'word-replacer'), { recursive: true });
  fs.writeFileSync(path.join(out, 'word-replacer', 'mine.txt'), 'keep me');
  const r = runUbuntu(project, out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not made by this script/);
  assert.equal(fs.readFileSync(path.join(out, 'word-replacer', 'mine.txt'), 'utf8'), 'keep me');

  const overlap = runUbuntu(project, path.join(project, 'extension'));
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /overlaps the source/);
  assert.ok(fs.existsSync(path.join(project, 'extension', 'manifest.json')), 'source intact');
});

// ---------------------------------------------------------------------------------------------
// Windows (via WSL interop)
// ---------------------------------------------------------------------------------------------

/** Runs a Windows command from WSL with C:\ as the working directory. */
function win(cmd, args, input) {
  return spawnSync(cmd, args, { cwd: '/mnt/c', encoding: 'utf8', input: input || '' });
}

const WINDOWS = (() => {
  if (!fs.existsSync('/mnt/c') || win('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status !== 0) return null;
  const temp = win('cmd.exe', ['/d', '/c', 'echo %TEMP%']).stdout.trim();
  return { temp: spawnSync('wslpath', ['-u', temp], { encoding: 'utf8' }).stdout.trim() };
})();
const toWin = (p) => spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }).stdout.trim();
const skipWindows = WINDOWS ? false : 'needs Windows PowerShell (run inside WSL)';

/** Runs the Windows PowerShell script of a project copy directly (exit code is reliable). */
function runPs1(project, out) {
  return win('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    toWin(path.join(project, 'scripts', 'make-extension-windows.ps1')), toWin(out), '-NoClipboard',
  ]);
}

test('Windows script: double-click launcher builds the ZIP + extension folder', { skip: skipWindows }, (t) => {
  const tmp = fs.mkdtempSync(path.join(WINDOWS.temp, 'wr-mk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = projectCopy(os.tmpdir()); // project inside WSL, like on the build machine
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const out = path.join(tmp, 'out');
  const r = win('cmd.exe', ['/d', '/c', toWin(path.join(project, 'make-extension-windows.cmd')), toWin(out), '-NoClipboard'], '\r\n');
  assert.match(r.stdout, /Done!/, r.stdout + r.stderr);
  assert.match(r.stdout, /Extension folder \(load it in Vivaldi\): +[A-Z]:\\.*\\word-replacer/);
  assertOutput(out);

  fs.writeFileSync(path.join(out, 'word-replacer', 'stale.txt'), 'old');
  const again = runPs1(project, out);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(fs.existsSync(path.join(out, 'word-replacer', 'stale.txt')), false);
  assertOutput(out);
});

test('Windows script: refuses a folder it did not make, and output overlapping the source', { skip: skipWindows }, (t) => {
  const tmp = fs.mkdtempSync(path.join(WINDOWS.temp, 'wr-mk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = projectCopy(tmp);
  const out = path.join(tmp, 'out');
  fs.mkdirSync(path.join(out, 'word-replacer'), { recursive: true });
  fs.writeFileSync(path.join(out, 'word-replacer', 'mine.txt'), 'keep me');
  const r = runPs1(project, out);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not made by this script/);
  assert.equal(fs.readFileSync(path.join(out, 'word-replacer', 'mine.txt'), 'utf8'), 'keep me');

  const overlap = runPs1(project, path.join(project, 'extension'));
  assert.equal(overlap.status, 1);
  assert.match(overlap.stdout, /overlaps the source/);
  assert.ok(fs.existsSync(path.join(project, 'extension', 'manifest.json')), 'source intact');
});
