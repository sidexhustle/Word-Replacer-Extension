/**
 * ui.test.js — E2E tests of the background worker, popup and options page.
 *
 * Purpose: verify the toolbar badge count/"off" state, the right-click "Replace “…” with…" flow
 * (and its options-page fallback), the options page (edit/autosave, import/export, external
 * changes, bundled rules.json banner), the popup switches, and that reloading the extension
 * hands over cleanly to the new content scripts (no double replacement).
 */
'use strict';

const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./harness.js');

const RULES = [
  { from: 'apple', to: 'A1' },
  { from: 'banana', to: 'B2' },
  { from: 'cat', to: 'cats' },
];
const OPTIONS_URL = `chrome-extension://${H.EXTENSION_ID}/options/options.html`;
const POPUP_URL = `chrome-extension://${H.EXTENSION_ID}/popup/popup.html`;

describe('background, popup and options page', () => {
  let browser;
  let srv;
  let A;

  /** Current service worker (it changes after an extension reload). */
  const sw = () => browser.sw;

  before(async () => {
    srv = await H.startServer();
    A = `http://127.0.0.1:${srv.port}`;
    browser = await H.launch();
    await H.setSettings(sw(), { rules: RULES });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  /** Opens a fixture page and waits until #h1 (static page) is replaced. */
  async function openStatic() {
    const page = await browser.context.newPage();
    await page.goto(`${A}/static.html`);
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });
    return page;
  }

  /** Badge text of a tab. */
  const badge = (tabId) => sw().evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);

  /** Rules as [from, to] pairs. */
  const rulePairs = async () => (await H.getSettings(sw())).rules.map((r) => [r.from, r.to]);

  test('badge shows the live replacement count, and "off" when paused', async () => {
    const page = await openStatic();
    const tabId = await H.tabIdFor(sw(), `${A}/static.html`);
    const first = Number(await H.waitFor(async () => /^\d+$/.test(await badge(tabId)) && badge(tabId)));
    assert.ok(first >= 15, `badge count ${first}`);

    await page.evaluate(() => document.body.append(' apple apple'));
    await H.waitFor(() => badge(tabId), { expected: String(first + 2), timeout: 6000 });

    await H.setSettings(sw(), { enabled: false });
    await H.waitFor(() => badge(tabId), { expected: 'off' });
    await H.setSettings(sw(), { enabled: true });
    await H.waitFor(() => badge(tabId), { expected: String(first + 2) });

    await H.setSettings(sw(), { disabledSites: ['127.0.0.1'] });
    await H.waitFor(() => badge(tabId), { expected: 'off' });
    await H.setSettings(sw(), { disabledSites: [] });
    await H.waitFor(() => badge(tabId), { expected: String(first + 2) });
    await page.close();
  });

  test('context menu "Replace “…” with…" prompts in the page and adds the rule', async () => {
    const page = await openStatic();
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'z';
      p.textContent = 'zebra crossing';
      document.body.append(p);
    });
    const tabId = await H.tabIdFor(sw(), `${A}/static.html`);
    let dialogMessage = '';
    page.once('dialog', (d) => {
      dialogMessage = d.message();
      d.accept('ZZ');
    });
    await sw().evaluate(async (id) => {
      const tab = await chrome.tabs.get(id);
      await self.handleMenuClick({ menuItemId: 'wr-add-rule', selectionText: '  zebra \n' }, tab);
    }, tabId);
    assert.match(dialogMessage, /Replace “zebra” with/);
    assert.deepEqual((await rulePairs()).find(([f]) => f === 'zebra'), ['zebra', 'ZZ']);
    await H.waitFor(() => page.textContent('#z'), { expected: 'ZZ crossing' });

    // Second time: the current replacement is pre-filled; cancelling changes nothing.
    let defaultValue = null;
    page.once('dialog', (d) => {
      defaultValue = d.defaultValue();
      d.dismiss();
    });
    await sw().evaluate(async (id) => {
      const tab = await chrome.tabs.get(id);
      await self.handleMenuClick({ menuItemId: 'wr-add-rule', selectionText: 'Zebra' }, tab);
    }, tabId);
    assert.equal(defaultValue, 'ZZ');
    assert.deepEqual((await rulePairs()).find(([f]) => f === 'zebra'), ['zebra', 'ZZ']);
    await page.close();
  });

  test('context menu falls back to the options page where scripts cannot run', async () => {
    const pagePromise = browser.context.waitForEvent('page', { predicate: (p) => p.url().startsWith(OPTIONS_URL) });
    await sw().evaluate(() => self.handleMenuClick({ menuItemId: 'wr-add-rule', selectionText: 'kiwi' }, { id: -1 }));
    const options = await pagePromise;
    await H.waitFor(() => options.evaluate(() => document.activeElement?.classList.contains('r-to')));
    const focusedFrom = await options.evaluate(() => document.activeElement.closest('tr').querySelector('.r-from').value);
    assert.equal(focusedFrom, 'kiwi');
    await options.keyboard.type('KW');
    await H.waitFor(async () => (await rulePairs()).some(([f, t]) => f === 'kiwi' && t === 'KW'));
    await options.close();
  });

  test('options page: lists rules, adds / edits / deletes with autosave', async () => {
    const page = await browser.context.newPage();
    await page.goto(OPTIONS_URL);
    const stored = (await H.getSettings(sw())).rules.length;
    await H.waitFor(() => page.locator('#rules tr').count(), { expected: stored });

    await page.click('#addRule');
    const row = page.locator('#rules tr').last();
    await row.locator('.r-from').fill('mango');
    await row.locator('.r-to').fill('MG');
    await H.waitFor(async () => (await rulePairs()).some(([f, t]) => f === 'mango' && t === 'MG'));
    await H.waitFor(() => page.textContent('#status'), { expected: 'Saved ✓' });

    await row.locator('.r-match').selectOption('wholeWord');
    await row.locator('.r-enabled').uncheck();
    await H.waitFor(async () => {
      const r = (await H.getSettings(sw())).rules.find((x) => x.from === 'mango');
      return r && r.match === 'wholeWord' && r.enabled === false;
    });

    await row.locator('.r-delete').click();
    await H.waitFor(async () => !(await rulePairs()).some(([f]) => f === 'mango'));

    // An empty "Find" is shown as not saved and never stored.
    await page.click('#addRule');
    await page.locator('#rules tr').last().locator('.r-to').fill('orphan');
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(!(await rulePairs()).some(([, t]) => t === 'orphan'));
    assert.match(await page.textContent('#rulesSummary'), /not saved/);
    await page.close();
  });

  test('options page: import (merge / replace) and export round trip', async () => {
    const page = await browser.context.newPage();
    await page.goto(OPTIONS_URL);
    const file = (rules) => ({
      name: 'rules.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'vivaldi-word-replacer', version: 1, rules })),
    });

    await page.selectOption('#importMode', 'merge');
    await page.setInputFiles('#importFile', file([{ from: 'papaya', to: 'PP' }, { from: 'apple', to: 'A1!' }]));
    await H.waitFor(async () => (await rulePairs()).some(([f]) => f === 'papaya'));
    const merged = await rulePairs();
    assert.deepEqual(merged.find(([f]) => f === 'apple'), ['apple', 'A1!']);
    assert.ok(merged.some(([f]) => f === 'banana'), 'existing rules kept on merge');
    await H.waitFor(() => page.locator('#rules tr').count(), { expected: merged.length });

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
    assert.equal(download.suggestedFilename(), 'rules.json');
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.format, 'vivaldi-word-replacer');
    assert.deepEqual(exported.rules.map((r) => [r.from, r.to]), merged);

    await page.selectOption('#importMode', 'replace');
    await page.setInputFiles('#importFile', file([{ from: 'guava', to: 'GV' }]));
    await H.waitFor(async () => JSON.stringify(await rulePairs()) === JSON.stringify([['guava', 'GV']]));
    assert.match(await page.textContent('#importResult'), /Replaced with 1 rules/);

    await H.setSettings(sw(), { rules: RULES });
    await page.close();
  });

  test('options page: picks up rules added elsewhere and never loses them when saving', async () => {
    const page = await browser.context.newPage();
    await page.goto(OPTIONS_URL);
    await H.waitFor(() => page.locator('#rules tr').count(), { expected: RULES.length });

    await sw().evaluate(() =>
      self.WRSettings.updateSettings((s) => {
        s.rules = self.WRSettings.upsertRule(s.rules, { from: 'lychee', to: 'LY' });
      })
    );
    await H.waitFor(() => page.locator('#rules .r-from').evaluateAll((els) => els.some((e) => e.value === 'lychee')));

    // Simulate a race: a rule is added elsewhere while the page has unsaved edits.
    await page.click('#addRule');
    await page.locator('#rules tr').last().locator('.r-from').fill('fig');
    await sw().evaluate(() =>
      self.WRSettings.updateSettings((s) => {
        s.rules = self.WRSettings.upsertRule(s.rules, { from: 'date', to: 'DT' });
      })
    );
    await page.locator('#rules tr').last().locator('.r-to').fill('FG');
    await H.waitFor(async () => {
      const pairs = await rulePairs();
      return pairs.some(([f]) => f === 'fig') && pairs.some(([f]) => f === 'date') && pairs.some(([f]) => f === 'lychee');
    });
    await H.waitFor(() => page.locator('#rules .r-from').evaluateAll((els) => els.some((e) => e.value === 'date')));
    await H.setSettings(sw(), { rules: RULES });
    await page.close();
  });

  test('options page: rules replaced elsewhere while typing here are not resurrected', async () => {
    const page = await browser.context.newPage();
    await page.goto(OPTIONS_URL);
    await H.waitFor(() => page.locator('#rules tr').count(), { expected: RULES.length });
    await page.click('#addRule');
    const row = page.locator('#rules tr').last();
    await row.locator('.r-from').fill('fig');
    await row.locator('.r-to').fill('FG');
    // e.g. "Replace my rules" import in another tab, before this page's autosave fires
    await H.setSettings(sw(), { rules: [{ from: 'guava', to: 'GV' }] });
    await H.waitFor(async () => JSON.stringify(await rulePairs()) === JSON.stringify([['guava', 'GV'], ['fig', 'FG']]), {
      message: async () => `stored: ${JSON.stringify(await rulePairs())}`,
    });
    await H.waitFor(() => page.locator('#rules .r-from').evaluateAll((els) => els.map((e) => e.value).join(',')), {
      expected: 'guava,fig',
    });
    await H.setSettings(sw(), { rules: RULES });
    await page.close();
  });

  test('options page: "See the difference" box shows each match mode', async () => {
    const page = await browser.context.newPage();
    await page.goto(OPTIONS_URL);
    const cells = () =>
      page.evaluate(() => ['cmpAnywhere', 'cmpWordStart', 'cmpWholeWord'].map((id) => document.getElementById(id).textContent));
    await H.waitFor(async () => (await cells())[0] !== '');
    assert.deepEqual(await cells(), [
      'colour, colours, watercolour, colourado',
      'colour, colours, watercolor, colourado',
      'colour, Colors, watercolor, Colorado',
    ]);
    assert.equal(await page.locator('#cmpWholeWord mark').count(), 1, 'replacements are highlighted');

    await page.fill('#cmpFrom', 'cat');
    await page.fill('#cmpTo', 'dog');
    await page.fill('#cmpText', 'cat, cats, category');
    assert.deepEqual(await cells(), ['dog, dogs, dogegory', 'dog, dogs, dogegory', 'dog, cats, category']);
    await page.close();
  });

  test('options page: an edit typed right before closing the tab is not lost', async () => {
    const page = await browser.context.newPage();
    await page.goto(OPTIONS_URL);
    await H.waitFor(() => page.locator('#rules tr').count(), { expected: RULES.length });
    await page.locator('#rules tr').first().locator('.r-to').fill('NEWA');
    await page.close({ runBeforeUnload: true }); // well within the 400 ms autosave debounce
    await H.waitFor(async () => (await rulePairs()).some(([f, t]) => f === 'apple' && t === 'NEWA'));
    await H.setSettings(sw(), { rules: RULES });
  });

  test('options page: banner offers to import a changed extension/rules.json', async () => {
    await sw().evaluate(() => chrome.storage.local.set({ 'wr.bundledRulesHash': 'stale' }));
    const page = await browser.context.newPage();
    await page.goto(OPTIONS_URL);
    await H.waitFor(() => page.isVisible('#bundledBanner'));
    await page.click('[data-bundled="merge"]');
    await H.waitFor(async () => !(await page.isVisible('#bundledBanner')));
    const hash = await sw().evaluate(async () => (await chrome.storage.local.get('wr.bundledRulesHash'))['wr.bundledRulesHash']);
    const real = await sw().evaluate(async () => (await self.WRSettings.fetchBundledRules()).hash);
    assert.equal(hash, real);
    const pairs = await rulePairs();
    assert.deepEqual(pairs.find(([f]) => f === 'color'), ['color', 'colour'], 'example rules merged in');
    assert.ok(pairs.some(([f]) => f === 'cat'), 'own rules kept on merge');
    await page.reload();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.isVisible('#bundledBanner'), false);
    await H.setSettings(sw(), { rules: RULES });
    await page.close();
  });

  test('right-click "turn off/on for this site" switches the current website off and back on', async () => {
    const page = await openStatic();
    const tabId = await H.tabIdFor(sw(), `${A}/static.html`);
    const toggle = () =>
      sw().evaluate(async (id) => {
        const tab = await chrome.tabs.get(id);
        await self.handleMenuClick({ menuItemId: 'wr-toggle-site' }, tab);
      }, tabId);

    await toggle();
    assert.deepEqual((await H.getSettings(sw())).disabledSites, ['127.0.0.1']);
    await H.waitFor(() => page.textContent('#h1'), { expected: 'Apple tips' });
    await H.waitFor(() => badge(tabId), { expected: 'off' });

    await toggle();
    assert.deepEqual((await H.getSettings(sw())).disabledSites, []);
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });
    await page.close();
  });

  test('popup explains when a broader entry (parent domain) turns the site off, and can undo it', async () => {
    const url = `http://app.localhost:${srv.port}/static.html`;
    const page = await browser.context.newPage();
    await page.goto(url);
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });
    await H.setSettings(sw(), { disabledSites: ['localhost', 'example.com'] });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'Apple tips' });

    const tabId = await H.tabIdFor(sw(), url);
    const popup = await browser.context.newPage();
    await popup.goto(`${POPUP_URL}?tabId=${tabId}`);
    await H.waitFor(() => popup.isVisible('#siteNote'));
    assert.equal(await popup.textContent('#siteLabel'), 'Active on app.localhost');
    assert.equal(await popup.isChecked('#siteActive'), false);
    assert.match(await popup.textContent('#siteNote'), /“localhost” is in your disabled sites/);

    await popup.click('#siteActive');
    await H.waitFor(async () => JSON.stringify((await H.getSettings(sw())).disabledSites) === '["example.com"]');
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });
    await H.waitFor(async () => !(await popup.isVisible('#siteNote')));
    await H.setSettings(sw(), { disabledSites: [] });
    await popup.close();
    await page.close();
  });

  test('popup: shows the count and toggles the current site and the global switch', async () => {
    const page = await openStatic();
    const tabId = await H.tabIdFor(sw(), `${A}/static.html`);
    await H.waitFor(async () => /^\d+$/.test(await badge(tabId)));
    const popup = await browser.context.newPage();
    await popup.goto(`${POPUP_URL}?tabId=${tabId}`);
    await H.waitFor(async () => /^\d+ replacements on this page$/.test(await popup.textContent('#count')));
    assert.equal(await popup.textContent('#siteLabel'), 'Active on 127.0.0.1');
    assert.equal(await popup.isChecked('#siteActive'), true);

    await popup.click('#siteActive');
    await H.waitFor(async () => (await H.getSettings(sw())).disabledSites.includes('127.0.0.1'));
    await H.waitFor(() => page.textContent('#h1'), { expected: 'Apple tips' });
    await H.waitFor(() => popup.textContent('#count'), { expected: 'Paused on this site' });

    await popup.click('#siteActive');
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });

    await popup.click('#enabled');
    await H.waitFor(() => popup.textContent('#count'), { expected: 'Paused everywhere' });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'Apple tips' });
    await popup.click('#enabled');
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });
    await popup.close();
    await page.close();
  });

  test('update/reload hand-over: re-injected content scripts take over cleanly (no double replacement)', async () => {
    const page = await browser.context.newPage();
    await page.goto(`${A}/fight.html`);
    await H.waitFor(() => page.textContent('#grow'), { expected: 'cats' });

    // Exactly what the worker does on install/update/reload: inject into all open tabs again.
    await sw().evaluate(() => self.injectIntoOpenTabs());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.textContent('#grow'), 'cats', 'old instance restored "cat", new one applied once');

    // Exactly one live instance keeps observing (one replacement, not two).
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p id="after">cat after reload</p>'));
    await H.waitFor(() => page.textContent('#after'), { expected: 'cats after reload' });
    await H.setSettings(sw(), { enabled: false });
    await H.waitFor(() => page.textContent('#after'), { expected: 'cat after reload' });
    assert.equal(await page.textContent('#grow'), 'cat');
    await H.setSettings(sw(), { enabled: true });
    await H.waitFor(() => page.textContent('#grow'), { expected: 'cats' });
    assert.equal(await page.textContent('#after'), 'cats after reload');
    await page.close();
  });

  // Must stay last: in Playwright's Chromium, runtime.reload() unloads a command-line extension.
  test('when the extension goes away (disabled/removed/reloading), pages get their original text back', async () => {
    const page = await openStatic();
    await sw().evaluate(() => chrome.runtime.reload()).catch(() => {});
    await H.waitFor(() => page.textContent('#h1'), { expected: 'Apple tips', timeout: 10000 });
    assert.equal(await page.title(), 'Apple prep – Banana');
    await page.close();
  });
});
