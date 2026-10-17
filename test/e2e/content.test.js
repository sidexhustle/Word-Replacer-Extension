/**
 * content.test.js — E2E tests of the content script in real Chromium with the extension loaded.
 *
 * Purpose: prove the replacement works on any kind of page without breaking it: static text,
 * title and display attributes; untouched scripts/styles/form values/editors; dynamic content;
 * React (client + SSR hydration); shadow DOM (open/closed/declarative/late/nested/Lit);
 * iframes (same-origin/srcdoc/about:blank/blob/cross-origin); ping-pong protection; live
 * on/off, rule edits, per-surface and per-site switches.
 */
'use strict';

const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const RULES = [
  { from: 'apple', to: 'A1' },
  { from: 'banana', to: 'B2' },
  { from: 'cà phê', to: 'cf' },
  { from: 'ice cream', to: 'IC' },
  { from: 'cat', to: 'cats' },
  { from: 'mango', to: 'MG', match: 'wholeWord' },
];

describe('content script', () => {
  let browser;
  let sw;
  let srvA;
  let srvB;
  let A;
  const pageErrors = [];

  before(async () => {
    await H.buildBundles();
    srvA = await H.startServer();
    srvB = await H.startServer();
    A = `http://127.0.0.1:${srvA.port}`;
    browser = await H.launch();
    sw = browser.sw;
    browser.context.on('weberror', (e) => pageErrors.push(String(e.error())));
  });

  after(async () => {
    await browser?.close();
    await srvA?.close();
    await srvB?.close();
  });

  /** Opens a fixture page and waits until `selector` shows `expected`. */
  async function open(pathname, selector, expected) {
    const page = await browser.context.newPage();
    await page.goto(A + pathname);
    if (selector) {
      await H.waitFor(() => page.textContent(selector), { expected, message: `${selector} != ${expected}` });
    }
    return page;
  }

  test('extension loads with the pinned ID and seeds the bundled rules.json on first install', async () => {
    assert.ok(sw.url().startsWith(`chrome-extension://${H.EXTENSION_ID}/`), sw.url());
    const s = await H.getSettings(sw);
    assert.deepEqual(s.rules.map((r) => [r.from, r.to, r.match, r.enabled]), [
      ['color', 'colour', 'anywhere', false],
      ['organize', 'organise', 'wordStart', false],
      ['gray', 'grey', 'wholeWord', false],
    ]);
    const hash = await sw.evaluate(async () => (await chrome.storage.local.get('wr.bundledRulesHash'))['wr.bundledRulesHash']);
    assert.match(hash, /^[0-9a-f]{64}$/);
    await H.setSettings(sw, { rules: RULES });
  });

  test('static page: visible text, tab title and display attributes are replaced', async () => {
    const page = await open('/static.html', '#h1', 'A1 tips');
    const r = await page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      return {
        title: document.title,
        p1: $('p1').textContent,
        link: $('link').title,
        ph: $('ph').placeholder,
        btn: $('btn').value,
        img: $('img').alt,
        opt1: $('opt1').textContent,
        opt2: $('opt2').textContent,
        og: $('og').label,
        pre: $('pre').textContent,
        svgt: $('svgt').textContent,
        svgtitle: $('svgtitle').textContent,
        vi: $('vi').textContent,
        nfd: $('nfd').textContent,
        shy: $('shy').textContent,
        nbsp: $('nbsp').textContent,
        cefalse: $('cefalse').textContent,
      };
    });
    assert.deepEqual(r, {
      title: 'A1 prep – B2',
      p1: 'My A1 is about B2s. A1S and A1sauce. pineA1 too.',
      link: 'Open A1 notes',
      ph: 'Search A1s',
      btn: 'Schedule A1',
      img: 'A1 photo',
      opt1: 'A1',
      opt2: 'A1 two',
      og: 'A1 group',
      pre: 'code A1',
      svgt: 'A1 svg',
      svgtitle: 'A1 tooltip',
      vi: 'Uống cf mỗi sáng',
      nfd: 'Uống cf (NFD)',
      shy: 'A1 soft',
      nbsp: 'IC here',
      cefalse: 'A1 not editable',
    });
    await page.close();
  });

  test('static page: scripts, styles, form values, editors and templates are untouched', async () => {
    const page = await open('/static.html', '#h1', 'A1 tips');
    const r = await page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      const form = Object.fromEntries(new FormData($('form')));
      return {
        inlineScript: window.__inlineScriptText,
        scriptText: document.scripts[0].textContent.includes('apple inside a script'),
        json: JSON.parse($('json').textContent),
        styleApplies: getComputedStyle($('p2')).color,
        styleText: document.querySelector('style').textContent.includes('.apple-card'),
        valAttr: $('val').getAttribute('value'),
        valProp: $('val').value,
        ta: $('ta').value,
        ce: $('ce').textContent,
        island: $('island').textContent,
        selectValue: $('sel').value,
        form,
        split: $('split').textContent,
        noscript: document.querySelector('noscript').textContent,
        template: $('tpl').content.textContent,
      };
    });
    assert.equal(r.inlineScript, 'apple inside a script');
    assert.equal(await page.getAttribute('#btn2', 'value'), 'Save apple', 'named submit button value is form data');
    assert.equal(r.scriptText, true);
    assert.deepEqual(r.json, { appleId: 1, text: 'apple' });
    assert.equal(r.styleApplies, 'rgb(255, 0, 0)');
    assert.equal(r.styleText, true);
    assert.equal(r.valAttr, 'apple typed by user');
    assert.equal(r.valProp, 'apple typed by user');
    assert.equal(r.ta, 'apple in textarea');
    assert.equal(r.ce, 'apple in editor apple island');
    assert.equal(r.island, 'apple island');
    assert.equal(r.selectValue, 'Apple', 'option without value attribute keeps submitting its original text');
    assert.deepEqual(r.form, { q: '', v: 'apple typed by user', t: 'apple in textarea', s: 'Apple' });
    assert.equal(r.split, 'Apple split stays', 'words split across tags are not matched');
    assert.equal(r.noscript, 'apple noscript');
    assert.equal(r.template, 'apple in template');
    await page.close();
  });

  test('dynamic content, text changes, attributes and title updates are replaced', async () => {
    const page = await open('/dynamic.html');
    await H.waitFor(() => page.evaluate(() => window.__dynDone === true));
    await H.waitFor(() => page.textContent('#li2'), { expected: 'B2 B' });
    const r = await page.evaluate(() => ({
      later: document.getElementById('later').textContent,
      data: document.getElementById('data').textContent,
      li1: document.getElementById('li1').textContent,
      attr: document.getElementById('attr').title,
      title: document.title,
    }));
    assert.deepEqual(r, {
      later: 'Added A1 later',
      data: 'changed to A1',
      li1: 'A1 A',
      attr: 'A1 tooltip',
      title: 'New A1 title',
    });
    await page.close();
  });

  test('bulk insertion of 5,000 rows is processed before the next task (fast, no flash)', async () => {
    const page = await open('/dynamic.html');
    const ms = await page.evaluate(() => window.addBulk(5000));
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#bulk div')];
      return {
        rows: rows.length,
        text: rows.filter((d) => d.textContent.endsWith('A1 B2')).length,
        title: rows.filter((d) => d.title.endsWith('A1')).length,
      };
    });
    assert.deepEqual(r, { rows: 5000, text: 5000, title: 5000 });
    assert.ok(ms < 2000, `5,000 rows took ${ms.toFixed(0)} ms`);
    console.log(`    5,000 rows inserted + replaced in ${ms.toFixed(0)} ms`);
    await page.close();
  });

  test('React SPA keeps working and replacements survive re-renders', async () => {
    const page = await open('/react.html', '#r-title', 'A1 #0');
    for (let i = 0; i < 3; i++) await page.click('#r-inc');
    await H.waitFor(() => page.textContent('#r-title'), { expected: 'A1 #3' });
    assert.equal(await page.textContent('#r-text'), 'Your A1 count is 3');
    assert.equal(await page.textContent('#r-inc'), 'Next A1');
    await page.click('#r-add');
    await H.waitFor(() => page.evaluate(() => [...document.querySelectorAll('#r-list li')].map((li) => li.textContent).join('|')), {
      expected: 'A1 one|B2 two|A1 3',
    });
    await page.click('#r-remove');
    await H.waitFor(() => page.evaluate(() => [...document.querySelectorAll('#r-list li')].map((li) => li.textContent).join('|')), {
      expected: 'B2 two|A1 3',
    });
    const r = await page.evaluate(() => ({
      placeholder: document.getElementById('r-input').placeholder,
      value: document.getElementById('r-input').value,
      errors: window.__pageErrors,
    }));
    assert.deepEqual(r, { placeholder: 'type A1', value: 'apple typed', errors: [] });
    await page.close();
  });

  test('React SSR + hydration recovers and stays interactive', async () => {
    const page = await open('/react-ssr.html', '#r-title', 'A1 #0');
    await page.click('#r-inc');
    await H.waitFor(() => page.textContent('#r-title'), { expected: 'A1 #1' });
    assert.equal(await page.textContent('#r-text'), 'Your A1 count is 1');
    const r = await page.evaluate(() => ({ errors: window.__pageErrors, recoverable: window.__recoverable }));
    assert.deepEqual(r.errors, []);
    console.log(`    hydration recoverable mismatches handled by React: ${r.recoverable}`);
    await page.close();
  });

  test('shadow DOM: open, closed, declarative, late-upgraded, nested and Lit components', async () => {
    const page = await open('/shadow.html');
    const read = () =>
      page.evaluate(() => ({
        open: document.getElementById('open-host').shadowRoot.textContent,
        closed: window.__closed.textContent,
        detached: window.__detached.textContent,
        dsd: document.getElementById('dsd-host').shadowRoot.textContent,
        late: window.__late ? window.__late.textContent : null,
        nested: window.__nestedInner ? window.__nestedInner.textContent : null,
        lit: document.getElementById('lit').shadowRoot?.getElementById('lit-p')?.textContent ?? null,
      }));
    const expected = {
      open: 'A1 in open shadow',
      closed: 'A1 in closed shadow',
      detached: 'A1 in detached closed',
      dsd: 'A1 in declarative open',
      late: 'updated A1 late',
      nested: 'A1 nested inner',
      lit: 'Lit A1 0',
    };
    await H.waitFor(async () => JSON.stringify(await read()) === JSON.stringify(expected), {
      message: async () => `shadow content not replaced: ${JSON.stringify(await read())}`,
    });
    const text = (await H.allText(page)).join('\n');
    assert.ok(text.includes('A1 in declarative closed'), 'declarative closed root replaced');
    assert.ok(!/apple/i.test(text), `no "apple" left anywhere: ${text}`);

    await page.click('#lit-btn');
    await H.waitFor(() => page.evaluate(() => document.getElementById('lit').shadowRoot.getElementById('lit-p').textContent), {
      expected: 'Lit A1 1',
    });
    assert.equal(await page.evaluate(() => document.getElementById('lit').shadowRoot.getElementById('lit-btn').textContent), 'more A1');
    await page.close();
  });

  test('iframes: same-origin, srcdoc, about:blank, blob: and cross-origin', async () => {
    const page = await open(`/frames.html?b=${srvB.port}`, '#top', 'A1 top');
    const frameText = async () => {
      const out = {};
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const name = await f.evaluate(() => window.frameElement?.id ?? (location.host.startsWith('localhost') ? 'cross' : location.href));
        out[name] = await f.evaluate(() => document.body?.textContent.trim() ?? '');
      }
      return out;
    };
    const expected = { same: 'A1 child', srcdoc: 'A1 srcdoc', blank: 'A1 blank', blob: 'A1 blob', cross: 'A1 child' };
    await H.waitFor(async () => JSON.stringify(await frameText()) === JSON.stringify(expected), {
      timeout: 8000,
      message: async () => `frames not replaced: ${JSON.stringify(await frameText())}`,
    });
    await page.close();
  });

  test('rich-text editors (contenteditable, designMode) are never modified', async () => {
    const page = await open('/editor.html', '#outside', 'A1 outside');
    await H.waitFor(() => page.evaluate(() => window.__editDone === true));
    await new Promise((r) => setTimeout(r, 300));
    const r = await page.evaluate(() => ({
      editor: document.getElementById('ed').textContent,
      designMode: document.getElementById('dm').contentDocument.body.textContent,
    }));
    assert.deepEqual(r, {
      editor: 'apple inside editor added apple',
      designMode: 'apple design modemore apple',
    });
    await page.close();
  });

  test('a script that keeps resetting text cannot cause an endless loop; replacements never grow', async () => {
    const page = await open('/fight.html', '#grow', 'cats');
    await new Promise((r) => setTimeout(r, 500));
    const r = await page.evaluate(() => ({ grow: document.getElementById('grow').textContent, resets: window.__resets }));
    assert.equal(r.grow, 'cats', 'cat→cats is applied once, not cats→catss…');
    assert.ok(r.resets <= 200, `ping-pong stopped (resets: ${r.resets})`);
    await page.close();
  });

  test('turning off restores the original page; turning on and editing rules apply live', async () => {
    const page = await open('/static.html', '#h1', 'A1 tips');
    await H.setSettings(sw, { enabled: false });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'Apple tips' });
    const off = await page.evaluate(() => ({
      title: document.title,
      link: document.getElementById('link').title,
      optValueAttr: document.getElementById('opt1').hasAttribute('value'),
      opt1: document.getElementById('opt1').textContent,
    }));
    assert.deepEqual(off, { title: 'Apple prep – Banana', link: 'Open apple notes', optValueAttr: false, opt1: 'Apple' });

    await H.setSettings(sw, { enabled: true });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });

    await H.setSettings(sw, { rules: RULES.map((r) => (r.from === 'apple' ? { ...r, to: 'A2' } : r)) });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A2 tips' });
    assert.equal(await page.title(), 'A2 prep – B2');
    await H.setSettings(sw, { rules: RULES });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A1 tips' });
    await page.close();
  });

  test('surfaces can be switched off individually (tab title, tooltips)', async () => {
    const page = await open('/static.html', '#h1', 'A1 tips');
    await H.setSettings(sw, { surfaces: { title: false, tooltips: false } });
    await H.waitFor(() => page.title(), { expected: 'Apple prep – Banana' });
    assert.equal(await page.getAttribute('#link', 'title'), 'Open apple notes');
    assert.equal(await page.textContent('#h1'), 'A1 tips');
    assert.equal(await page.getAttribute('#ph', 'placeholder'), 'Search A1s');
    await H.setSettings(sw, { surfaces: { title: true, tooltips: true } });
    await H.waitFor(() => page.title(), { expected: 'A1 prep – B2' });
    await page.close();
  });

  test('"disable on this site" also covers the site\'s cross-origin iframes', async () => {
    const page = await open(`/frames.html?b=${srvB.port}`, '#top', 'A1 top');
    const cross = () => page.frames().find((f) => f.url().startsWith(`http://localhost:${srvB.port}/`));
    await H.waitFor(async () => (await cross()?.textContent('#c')) === 'A1 child');
    await H.setSettings(sw, { disabledSites: ['127.0.0.1'] });
    await H.waitFor(() => page.textContent('#top'), { expected: 'apple top' });
    await H.waitFor(() => cross().textContent('#c'), { expected: 'apple child' });
    await H.setSettings(sw, { disabledSites: [] });
    await H.waitFor(() => cross().textContent('#c'), { expected: 'A1 child' });
    await page.close();
  });

  test('streamed HTML appended to an already-rewritten text node: no compounding, exact restore', async () => {
    const page = await open('/stream.html', '#done', 'end');
    const expectedOn = `${'cats '.repeat(6000)}mangoes ${'cats '.repeat(6000)}`.trim();
    const expectedOff = `${'cat '.repeat(6000)}mangoes ${'cat '.repeat(6000)}`.trim();
    await H.waitFor(async () => (await page.textContent('#s')).trim() === expectedOn, {
      message: async () => {
        const t = await page.textContent('#s');
        return `stream text wrong: catss=${(t.match(/catss/g) || []).length} MG=${t.includes('MG')} len=${t.length}`;
      },
    });
    const nodes = await page.evaluate(() => document.getElementById('s').childNodes.length);
    console.log(`    streamed paragraph has ${nodes} text node(s)`);
    await H.setSettings(sw, { enabled: false });
    await H.waitFor(async () => (await page.textContent('#s')).trim() === expectedOff, { message: 'stream not restored exactly' });
    await H.setSettings(sw, { enabled: true });
    await H.waitFor(async () => (await page.textContent('#s')).trim() === expectedOn);
    await page.close();
  });

  test('<option> submitted value follows later text changes made by the page', async () => {
    const page = await open('/static.html', '#opt1', 'A1');
    const state = () =>
      page.evaluate(() => {
        const o = document.getElementById('opt1');
        document.getElementById('sel').selectedIndex = 0;
        return { text: o.textContent, value: o.value, attr: o.getAttribute('value'), form: new FormData(document.getElementById('form')).get('s') };
      });
    await page.evaluate(() => (document.getElementById('opt1').text = 'Phone screen'));
    await H.waitFor(async () => (await state()).attr === null, { message: async () => JSON.stringify(await state()) });
    assert.deepEqual(await state(), { text: 'Phone screen', value: 'Phone screen', attr: null, form: 'Phone screen' });

    await page.evaluate(() => (document.getElementById('opt1').text = 'Final apple'));
    await H.waitFor(async () => (await state()).text === 'Final A1');
    assert.deepEqual(await state(), { text: 'Final A1', value: 'Final apple', attr: 'Final apple', form: 'Final apple' });

    await page.evaluate(() => (document.getElementById('opt1').firstChild.data = 'Second apple round'));
    await H.waitFor(async () => (await state()).text === 'Second A1 round');
    assert.equal((await state()).form, 'Second apple round');
    await page.close();
  });

  test('content that becomes editable later gets its original text back before you edit', async () => {
    const page = await open('/editable.html', '#note', 'My A1 notes');
    await page.evaluate(() => (document.getElementById('note').contentEditable = 'true'));
    await H.waitFor(() => page.textContent('#note'), { expected: 'My apple notes' });
    await page.click('#note');
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await H.waitFor(() => page.textContent('#note'), { expected: 'My apple notes edited' });
    await page.evaluate(() => (document.getElementById('note').contentEditable = 'false'));
    await H.waitFor(() => page.textContent('#note'), { expected: 'My A1 notes edited' });

    const frame = page.frames().find((f) => f !== page.mainFrame());
    await H.waitFor(() => frame.textContent('#x'), { expected: 'A1 in frame' });
    await frame.evaluate(() => (document.designMode = 'on'));
    await frame.click('#x');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await H.waitFor(() => frame.textContent('#x'), { expected: 'apple in frame!' });
    await page.close();
  });

  test('content detached while settings change is restored / updated when re-inserted', async () => {
    const page = await open('/static.html', '#h1', 'A1 tips');
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = '<p id="cp" title="apple tip">apple list</p>';
      window.__cached = d;
      document.body.append(d);
    });
    await H.waitFor(() => page.textContent('#cp'), { expected: 'A1 list' });
    const cp = () => page.evaluate(() => {
      const p = window.__cached.querySelector('#cp');
      return `${p.textContent}|${p.title}`;
    });

    await page.evaluate(() => window.__cached.remove());
    await H.setSettings(sw, { enabled: false });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'Apple tips' });
    await page.evaluate(() => document.body.append(window.__cached));
    await H.waitFor(cp, { expected: 'apple list|apple tip', message: 'not restored while paused' });

    await H.setSettings(sw, { enabled: true });
    await H.waitFor(cp, { expected: 'A1 list|A1 tip' });
    await page.evaluate(() => window.__cached.remove());
    await H.setSettings(sw, { rules: RULES.map((r) => (r.from === 'apple' ? { ...r, to: 'A2' } : r)) });
    await H.waitFor(() => page.textContent('#h1'), { expected: 'A2 tips' });
    await page.evaluate(() => document.body.append(window.__cached));
    await H.waitFor(cp, { expected: 'A2 list|A2 tip', message: 'stale replacement not updated' });
    await H.setSettings(sw, { rules: RULES });
    await page.close();
  });

  test('no uncaught page errors were caused by the extension', () => {
    assert.deepEqual(pageErrors, []);
  });
});
