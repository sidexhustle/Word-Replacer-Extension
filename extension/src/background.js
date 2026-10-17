/**
 * background.js — Service worker of Word Replacer.
 *
 * Purpose:
 *  - First install: seed settings from the bundled extension/rules.json.
 *  - Install/update/reload: inject the content scripts into tabs that are already open, so you
 *    never have to refresh pages (older instances restore their page and step aside).
 *  - Context menu "Replace “<selection>” with…": asks for the replacement with a prompt in the
 *    page and adds/updates the rule (falls back to the options page on restricted pages).
 *  - Context menu "Word Replacer: turn off/on for this site": per-site switch from any page.
 *  - Toolbar badge: live number of replacements in the tab (sum over frames) or "off".
 */
importScripts('shared/engine.js', 'shared/settings.js');

const Engine = self.WREngine;
const Settings = self.WRSettings;
const MENU_ID = 'wr-add-rule';
const SITE_MENU_ID = 'wr-toggle-site';
const COUNTS_KEY = 'wr.tabCounts';
const MAX_SELECTION_LENGTH = 200;
const BADGE_COLOR_ON = '#2563eb';
const BADGE_COLOR_OFF = '#8a8a8a';

// Event listeners must be registered synchronously at top level (MV3 service worker rule).
chrome.runtime.onInstalled.addListener((details) => {
  handleInstalled(details).catch((e) => console.error('[Word Replacer] install handling failed', e));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((e) => console.error('[Word Replacer] context menu failed', e));
});
chrome.runtime.onMessage.addListener(onMessage);
chrome.tabs.onRemoved.addListener((tabId) => {
  withCounts((counts) => {
    delete counts[tabId];
    return [];
  });
});

// -----------------------------------------------------------------------------------------------
// Install / update
// -----------------------------------------------------------------------------------------------

/** Seeds settings (first install), (re)creates the context menu and injects into open tabs. */
async function handleInstalled(details) {
  await seedSettingsIfMissing();
  await createMenus();
  if (details.reason === 'install' || details.reason === 'update') await injectIntoOpenTabs();
}

/** On first install, stores default settings with the rules from the bundled rules.json. */
async function seedSettingsIfMissing() {
  if (await Settings.hasStoredSettings()) return;
  const settings = Settings.defaultSettings();
  try {
    const bundled = await Settings.fetchBundledRules();
    settings.rules = bundled.parsed.rules;
    if (bundled.parsed.settings) Object.assign(settings, bundled.parsed.settings);
    await chrome.storage.local.set({ [Settings.BUNDLED_HASH_KEY]: bundled.hash });
  } catch (e) {
    console.warn('[Word Replacer] could not read bundled rules.json', e);
  }
  await Settings.saveSettings(settings);
}

/** (Re)creates the context-menu entries (selected text → add rule; page → per-site switch). */
async function createMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create(
    { id: MENU_ID, title: 'Replace “%s” with…', contexts: ['selection'] },
    () => void chrome.runtime.lastError
  );
  chrome.contextMenus.create(
    {
      id: SITE_MENU_ID,
      title: 'Word Replacer: turn off/on for this site',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    },
    () => void chrome.runtime.lastError
  );
}

/** Injects the manifest's content scripts (both worlds) into every open http(s)/file tab. */
async function injectIntoOpenTabs() {
  const scripts = chrome.runtime.getManifest().content_scripts || [];
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.discarded || !/^(https?|file):/i.test(tab.url || '')) return;
      for (const cs of scripts) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: cs.js,
            world: cs.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
            injectImmediately: true,
          });
        } catch (_) {
          // Restricted page (Web Store, file:// without access, error page...): skip it.
        }
      }
    })
  );
}

// -----------------------------------------------------------------------------------------------
// Context menu
// -----------------------------------------------------------------------------------------------

/** Collapses whitespace in the selected text; returns '' when unusable. */
function normalizeSelection(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 0 && s.length <= MAX_SELECTION_LENGTH ? s : '';
}

/** Hostname of an http(s) URL, '' otherwise (per-site switching only makes sense there). */
function siteHostname(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
  } catch (_) {
    return '';
  }
}

/** Turns the extension off for the tab's (top-level) website, or back on if it was off there. */
async function toggleSiteForTab(tab) {
  const host = siteHostname(tab && tab.url);
  if (!host) return;
  await Settings.updateSettings((s) => {
    s.disabledSites = Settings.setSiteDisabled(s.disabledSites, host, !Settings.isSiteDisabled(s, host));
  });
}

/** Context-menu clicks: "Replace “…” with…" (prompt, then add/update the rule) or the site switch. */
async function handleMenuClick(info, tab) {
  if (info.menuItemId === SITE_MENU_ID) {
    await toggleSiteForTab(tab);
    return;
  }
  if (info.menuItemId !== MENU_ID) return;
  const word = normalizeSelection(info.selectionText);
  if (!word) return;
  const settings = await Settings.loadSettings();
  const key = Engine.ruleKey(word);
  const existing = settings.rules.find((r) => Engine.ruleKey(r.from) === key);

  let answer;
  try {
    answer = await promptInTab(tab, word, existing ? existing.to : '');
  } catch (_) {
    await openOptions(`add=${encodeURIComponent(word)}`);
    return;
  }
  if (typeof answer !== 'string' || answer.trim() === '') return; // cancelled / empty
  await addOrUpdateRule(word, answer.trim(), existing ? existing.match : Engine.DEFAULT_MATCH);
}

/** Adds a rule (or updates the rule with the same find text) and saves settings. */
async function addOrUpdateRule(from, to, match) {
  return Settings.updateSettings((s) => {
    s.rules = Settings.upsertRule(s.rules, { from, to, match, enabled: true });
  });
}

/** Shows window.prompt() in the tab's top frame and returns the answer (string or null). */
async function promptInTab(tab, word, current) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) throw new Error('No tab');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (w, cur) => window.prompt(`Word Replacer\n\nReplace “${w}” with:`, cur),
    args: [word, current],
  });
  if (!results || results.length === 0) throw new Error('No result');
  return results[0].result;
}

/** Opens the options page, optionally with a hash such as "add=word". */
async function openOptions(hash) {
  const url = chrome.runtime.getURL('options/options.html') + (hash ? `#${hash}` : '');
  await chrome.tabs.create({ url });
}

// -----------------------------------------------------------------------------------------------
// Badge / counts
// -----------------------------------------------------------------------------------------------

let countsPromise = null;
let countsQueue = Promise.resolve();

/** Loads the per-tab counts (kept in storage.session so they survive worker restarts). */
function loadCounts() {
  if (!countsPromise) {
    countsPromise = chrome.storage.session.get(COUNTS_KEY).then((r) => (r && r[COUNTS_KEY]) || {});
  }
  return countsPromise;
}

/**
 * Serialized read-modify-write of the counts; `mutator` returns the tab ids whose badge must be
 * refreshed.
 */
function withCounts(mutator) {
  countsQueue = countsQueue
    .then(async () => {
      const counts = await loadCounts();
      const tabIds = mutator(counts) || [];
      await chrome.storage.session.set({ [COUNTS_KEY]: counts });
      for (const tabId of tabIds) await refreshBadge(tabId, counts[tabId]);
    })
    .catch((e) => console.warn('[Word Replacer] count update failed', e));
  return countsQueue;
}

/** Total replacements in a tab entry. */
function tabTotal(entry) {
  return entry ? Object.values(entry.frames).reduce((a, b) => a + b, 0) : 0;
}

/** Formats a count for the badge (max 4 characters). */
function formatCount(n) {
  if (!n) return '';
  if (n > 9999) return '9k+';
  if (n > 999) return `${Math.floor(n / 1000)}k`;
  return String(n);
}

/** Updates the toolbar badge of one tab. */
async function refreshBadge(tabId, entry) {
  const off = Boolean(entry && entry.state && entry.state !== 'on');
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: off ? BADGE_COLOR_OFF : BADGE_COLOR_ON });
    await chrome.action.setBadgeText({ tabId, text: off ? 'off' : formatCount(tabTotal(entry)) });
  } catch (_) {
    /* tab closed */
  }
}

/** Messages from content scripts (counts) and the popup (status query). */
function onMessage(msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return undefined;
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'wr:hello': // a new document started in a tab's top frame: forget the old counts
      if (typeof tabId === 'number' && sender.frameId === 0) {
        withCounts((counts) => {
          counts[tabId] = { state: 'on', frames: {} };
          return [tabId];
        });
      }
      return undefined;
    case 'wr:count':
      if (typeof tabId === 'number') {
        const count = Math.max(0, Number(msg.count) || 0);
        withCounts((counts) => {
          const entry = counts[tabId] || (counts[tabId] = { state: 'on', frames: {} });
          entry.frames[sender.frameId || 0] = count;
          if (sender.frameId === 0 && typeof msg.state === 'string') entry.state = msg.state;
          return [tabId];
        });
      }
      return undefined;
    case 'wr:get-tab-status':
      loadCounts()
        .then(() => countsQueue)
        .then(() => loadCounts())
        .then((counts) => {
          const entry = counts[msg.tabId];
          sendResponse({ total: tabTotal(entry), state: entry ? entry.state : null });
        });
      return true; // async response
    default:
      return undefined;
  }
}
