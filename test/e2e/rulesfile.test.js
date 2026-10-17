/**
 * rulesfile.test.js — E2E tests for a hand-edited extension/rules.json (as described in MANUAL.md).
 *
 * Purpose: the simple {"word": "replacement"} format must work for a fresh install, and a broken
 * file (typo) must produce a clear message on the options page instead of failing silently.
 * Each test loads a temporary copy of the extension folder with its own rules.json.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./harness.js');

const OPTIONS_URL = `chrome-extension://${H.EXTENSION_ID}/options/options.html`;

/** Copies extension/ to a temp folder with the given rules.json text. */
function extensionWithRules(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-ext-'));
  fs.cpSync(H.EXT_DIR, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rules.json'), text);
  return dir;
}

test('a hand-written simple rules.json ({"word": "replacement"}) works on a fresh install', async (t) => {
  const extDir = extensionWithRules('{\n  "apple": "A1",\n  "banana": "B2"\n}\n');
  const srv = await H.startServer();
  const browser = await H.launch({ extDir });
  t.after(async () => {
    await browser.close();
    await srv.close();
    fs.rmSync(extDir, { recursive: true, force: true });
  });
  const s = await H.getSettings(browser.sw);
  assert.deepEqual(s.rules.map((r) => [r.from, r.to, r.match]), [
    ['apple', 'A1', 'anywhere'],
    ['banana', 'B2', 'anywhere'],
  ]);
  const page = await browser.context.newPage();
  await page.goto(`http://127.0.0.1:${srv.port}/static.html`);
  await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });
});

test('a broken rules.json shows a clear message on the options page', async (t) => {
  const extDir = extensionWithRules('{\n  "apple": "A1",\n  "banana": "B2",\n}\n'); // trailing comma
  const browser = await H.launch({ extDir });
  t.after(async () => {
    await browser.close();
    fs.rmSync(extDir, { recursive: true, force: true });
  });
  assert.deepEqual((await H.getSettings(browser.sw)).rules, [], 'nothing imported from the broken file');
  const page = await browser.context.newPage();
  await page.goto(OPTIONS_URL);
  await H.waitFor(() => page.isVisible('#bundledError'));
  assert.match(await page.textContent('#bundledError'), /rules\.json has a mistake/);
  assert.equal(await page.isVisible('#bundledBanner'), false);
});
