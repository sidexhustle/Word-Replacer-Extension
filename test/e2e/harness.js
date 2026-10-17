/**
 * harness.js — Shared helpers for the E2E tests.
 *
 * Purpose:
 *  - buildBundles(): bundles the React and Lit fixtures with esbuild (+ a server-side React
 *    renderer for the SSR/hydration fixture).
 *  - startServer(): static fixture server; also serves /react-ssr.html (server-rendered React)
 *    and accepts POST /report (used by the real-Vivaldi smoke test).
 *  - launch(): Chromium (Playwright) with the unpacked extension loaded, plus its service worker.
 *  - Small polling/assertion helpers, settings helpers and a CDP text dump that pierces closed
 *    shadow roots.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'extension');
const FIXTURES = path.join(__dirname, 'fixtures');
const BUILD = path.join(__dirname, '.build');
const EXTENSION_ID = 'cjaaplbkmdlkoaaonecnomdahnifbdpj';
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

/** Bundles the React/Lit fixtures (browser IIFEs) and the React SSR renderer (Node CJS). */
async function buildBundles() {
  const esbuild = require('esbuild');
  fs.mkdirSync(BUILD, { recursive: true });
  const common = {
    bundle: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  };
  await esbuild.build({ ...common, minify: true, format: 'iife', entryPoints: [path.join(FIXTURES, 'react-app.jsx')], outfile: path.join(BUILD, 'react-app.js') });
  await esbuild.build({ ...common, minify: true, format: 'iife', entryPoints: [path.join(FIXTURES, 'lit-app.js')], outfile: path.join(BUILD, 'lit-app.js') });
  await esbuild.build({
    ...common,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(BUILD, 'ssr.cjs'),
    stdin: {
      contents:
        "import { createElement } from 'react'; import { renderToString } from 'react-dom/server';" +
        "import { App } from './react-app.jsx'; export const render = () => renderToString(createElement(App));",
      resolveDir: FIXTURES,
      loader: 'jsx',
    },
  });
}

/** Renders the SSR fixture page (React markup + hydration bundle). */
function ssrPage() {
  const { render } = require(path.join(BUILD, 'ssr.cjs'));
  return `<!doctype html><html><head><meta charset="utf-8"><title>React SSR</title></head><body>
<div id="root" data-ssr="1">${render()}</div><script src="/.build/react-app.js"></script></body></html>`;
}

/**
 * Starts the fixture server.
 * @param {{host?: string, port?: number, reports?: object[]}} [opts]
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>}>}
 */
function startServer(opts = {}) {
  const reports = opts.reports || [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          reports.push(JSON.parse(body));
        } catch (_) {
          reports.push({ raw: body });
        }
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
      });
      return;
    }
    if (url.pathname === '/react-ssr.html') {
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] }).end(ssrPage());
      return;
    }
    if (url.pathname === '/stream.html') {
      // One long text run delivered in delayed chunks: the parser appends each chunk to the SAME
      // text node. Chunk 2 ends inside the word "mangoes".
      const chunks = [
        `<!doctype html><html><head><meta charset="utf-8"><title>Stream</title></head><body><p id="s">${'cat '.repeat(3000)}`,
        `${'cat '.repeat(3000)}mango`,
        `es ${'cat '.repeat(3000)}`,
        `${'cat '.repeat(3000)}</p><p id="done">end</p></body></html>`,
      ];
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] });
      let i = 0;
      const next = () => {
        if (i < chunks.length) {
          res.write(chunks[i++]);
          setTimeout(next, 150);
        } else {
          res.end();
        }
      };
      next();
      return;
    }
    const base = url.pathname.startsWith('/.build/') ? BUILD : FIXTURES;
    const rel = url.pathname.replace(/^\/(\.build\/)?/, '');
    const file = path.resolve(base, rel || 'index.html');
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(opts.port || 0, opts.host || '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        reports,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Polls `fn` until it returns a truthy value (or `expected` when given); throws on timeout.
 *  `message` may be a string or an (async) function evaluated at timeout. */
async function waitFor(fn, { timeout = 5000, interval = 50, expected, message } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (expected === undefined ? Boolean(last) : last === expected) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeout) {
      const msg = typeof message === 'function' ? await message() : message;
      throw new Error(`${msg || 'waitFor timed out'} (last value: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Launches Chromium with the unpacked extension; resolves once settings were seeded.
 * @param {{extDir?: string}} [opts] load a different copy of the extension folder
 */
async function launch({ extDir = EXT_DIR } = {}) {
  const { chromium } = require('playwright');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const sw = await getServiceWorker(context);
  await waitFor(() => sw.evaluate(() => self.WRSettings.hasStoredSettings()), { message: 'settings were not seeded' });
  return {
    context,
    sw,
    close: async () => {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Returns the extension's (current) service worker. */
async function getServiceWorker(context) {
  const existing = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
  return existing || context.waitForEvent('serviceworker', { predicate: (w) => w.url().includes(EXTENSION_ID) });
}

/** Reads settings through the service worker. */
function getSettings(sw) {
  return sw.evaluate(() => self.WRSettings.loadSettings());
}

/** Merges `patch` into the stored settings (through the service worker). */
function setSettings(sw, patch) {
  return sw.evaluate(async (p) => {
    const s = await self.WRSettings.loadSettings();
    Object.assign(s, p);
    if (p.surfaces) s.surfaces = { ...s.surfaces, ...p.surfaces };
    return self.WRSettings.saveSettings(s);
  }, patch);
}

/** Tab id of the first tab whose URL starts with `prefix`. */
function tabIdFor(sw, prefix) {
  return sw.evaluate(async (p) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => (x.url || '').startsWith(p));
    return t ? t.id : null;
  }, prefix);
}

/** All visible-text node values of a page (no script/style/template source), piercing open AND
 *  closed shadow roots and same-process iframes (via CDP). */
async function allText(page) {
  const cdp = await page.context().newCDPSession(page);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const out = [];
    const visit = (n) => {
      if (SKIP.has(n.nodeName)) return;
      if (n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue);
      for (const c of n.children || []) visit(c);
      for (const c of n.shadowRoots || []) visit(c);
      if (n.contentDocument) visit(n.contentDocument);
    };
    visit(root);
    return out;
  } finally {
    await cdp.detach();
  }
}

module.exports = {
  ROOT,
  EXT_DIR,
  EXTENSION_ID,
  buildBundles,
  startServer,
  waitFor,
  launch,
  getServiceWorker,
  getSettings,
  setSettings,
  tabIdFor,
  allText,
};
