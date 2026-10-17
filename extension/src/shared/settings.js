/**
 * settings.js — Settings schema, persistence and the portable rules-file format.
 *
 * Purpose: one place that knows how settings look, how they are sanitized, loaded from and
 * saved to chrome.storage.local, how sites are disabled, and how rules are exported/imported
 * (the same JSON format as the bundled extension/rules.json used to move rules between machines).
 * Loaded as a classic script (globalThis.WRSettings) by the content script, popup, options page
 * and background worker, and via require() by the Node unit tests.
 */
(function (root, factory) {
  const engine = root.WREngine || (typeof require === 'function' ? require('./engine.js') : null);
  const api = factory(engine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WRSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  const STORAGE_KEY = 'wr.settings';
  const BUNDLED_HASH_KEY = 'wr.bundledRulesHash';
  const SCHEMA_VERSION = 1;
  const PORTABLE_FORMAT = 'vivaldi-word-replacer';
  const PORTABLE_VERSION = 1;
  const SURFACE_KEYS = Object.freeze(['title', 'tooltips', 'placeholders', 'buttonLabels', 'altText']);

  /**
   * Returns a fresh default settings object.
   * @returns {{schemaVersion:number, enabled:boolean, surfaces:Record<string,boolean>, disabledSites:string[], rules:object[]}}
   */
  function defaultSettings() {
    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: true,
      surfaces: Object.fromEntries(SURFACE_KEYS.map((k) => [k, true])),
      disabledSites: [],
      rules: [],
    };
  }

  /**
   * Creates a reasonably unique id for a rule.
   * @returns {string}
   */
  function makeRuleId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      try { return crypto.randomUUID(); } catch (_) { /* insecure context */ }
    }
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Normalizes user input into a site key: lowercase hostname without "www.", port or path.
   * @param {unknown} input e.g. "https://www.Example.com/news" or "mail.google.com"
   * @returns {string} '' when the input is not a usable hostname
   */
  function normalizeSite(input) {
    let s = String(input ?? '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\*\./, '');
    s = s.replace(/^www\./, '').replace(/\.$/, '');
    return /^[a-z0-9.-]+$/.test(s) || /^\[[0-9a-f:]+\]$/.test(s) ? s : '';
  }

  /**
   * Disabled-site entries that cover a hostname: the site itself or one of its parent domains
   * (e.g. "google.com" covers "mail.google.com").
   * @param {{disabledSites?: string[]}} settings
   * @param {string} hostname
   * @returns {string[]}
   */
  function matchingSites(settings, hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host || !settings || !Array.isArray(settings.disabledSites)) return [];
    return settings.disabledSites.filter((site) => host === site || host.endsWith('.' + site));
  }

  /**
   * True when the hostname equals a disabled site or is one of its subdomains.
   * @param {{disabledSites?: string[]}} settings
   * @param {string} hostname
   * @returns {boolean}
   */
  function isSiteDisabled(settings, hostname) {
    return matchingSites(settings, hostname).length > 0;
  }

  /**
   * Turns a website off (adds its site key, unless a parent domain already covers it) or back on
   * (removes every entry that covers it). Shared by the popup and the right-click menu.
   * @param {string[]} disabledSites current list
   * @param {string} hostname the website's hostname, e.g. "www.example.com"
   * @param {boolean} disabled true = turn off on that site, false = turn back on
   * @returns {string[]} new list
   */
  function setSiteDisabled(disabledSites, hostname, disabled) {
    const list = Array.isArray(disabledSites) ? disabledSites.slice() : [];
    if (disabled) {
      const site = normalizeSite(hostname);
      if (site && !isSiteDisabled({ disabledSites: list }, hostname)) list.push(site);
      return list;
    }
    const covering = new Set(matchingSites({ disabledSites: list }, hostname));
    return list.filter((site) => !covering.has(site));
  }

  /**
   * Sanitizes a list of rules: normalizes fields, drops invalid ones, assigns missing/duplicate ids.
   * @param {unknown} rules
   * @returns {object[]}
   */
  function sanitizeRules(rules) {
    const ids = new Set();
    const out = [];
    for (const raw of Array.isArray(rules) ? rules : []) {
      const rule = Engine.normalizeRule(raw);
      if (Engine.validateRule(rule)) continue;
      if (!rule.id || ids.has(rule.id)) rule.id = makeRuleId();
      ids.add(rule.id);
      out.push(rule);
    }
    return out;
  }

  /**
   * Returns a complete, valid settings object built from possibly partial/invalid input.
   * @param {unknown} raw
   * @returns {ReturnType<typeof defaultSettings>}
   */
  function sanitizeSettings(raw) {
    const base = defaultSettings();
    const src = raw && typeof raw === 'object' ? raw : {};
    if (typeof src.enabled === 'boolean') base.enabled = src.enabled;
    if (src.surfaces && typeof src.surfaces === 'object') {
      for (const k of SURFACE_KEYS) if (typeof src.surfaces[k] === 'boolean') base.surfaces[k] = src.surfaces[k];
    }
    if (Array.isArray(src.disabledSites)) {
      base.disabledSites = [...new Set(src.disabledSites.map(normalizeSite).filter(Boolean))];
    }
    base.rules = sanitizeRules(src.rules);
    return base;
  }

  /**
   * True when settings were already stored (used to seed defaults only on first install).
   * @returns {Promise<boolean>}
   */
  async function hasStoredSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return Boolean(data && data[STORAGE_KEY]);
  }

  /**
   * Loads settings from chrome.storage.local (sanitized, defaults filled in).
   * @returns {Promise<ReturnType<typeof defaultSettings>>}
   */
  async function loadSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return sanitizeSettings(data && data[STORAGE_KEY]);
  }

  /**
   * Sanitizes and saves settings to chrome.storage.local.
   * @param {object} settings
   * @returns {Promise<ReturnType<typeof defaultSettings>>} the saved (sanitized) settings
   */
  async function saveSettings(settings) {
    const clean = sanitizeSettings(settings);
    await chrome.storage.local.set({ [STORAGE_KEY]: clean });
    return clean;
  }

  /**
   * Read-modify-write helper: loads settings, lets `mutator` change them, saves the result.
   * @param {(s: object) => (object|void|Promise<object|void>)} mutator mutate in place or return a new object
   * @returns {Promise<ReturnType<typeof defaultSettings>>}
   */
  async function updateSettings(mutator) {
    const current = await loadSettings();
    const result = await mutator(current);
    return saveSettings(result && typeof result === 'object' ? result : current);
  }

  /**
   * Inserts a rule or updates the existing rule with the same "find" text (ignoring case).
   * @param {object[]} rules
   * @param {object} rule
   * @returns {object[]} new array
   */
  function upsertRule(rules, rule) {
    const incoming = Engine.normalizeRule(rule);
    const key = Engine.ruleKey(incoming.from);
    const list = Array.isArray(rules) ? rules.slice() : [];
    const i = list.findIndex((r) => Engine.ruleKey(r.from) === key);
    if (i >= 0) list[i] = { ...list[i], to: incoming.to, match: incoming.match, enabled: incoming.enabled };
    else list.push({ ...incoming, id: incoming.id || makeRuleId() });
    return list;
  }

  /**
   * Merges incoming rules into existing ones (same "find" text → incoming wins; others appended).
   * @param {object[]} existing
   * @param {object[]} incoming
   * @returns {object[]}
   */
  function mergeRules(existing, incoming) {
    let list = Array.isArray(existing) ? existing.slice() : [];
    for (const rule of Array.isArray(incoming) ? incoming : []) list = upsertRule(list, { ...rule, id: '' });
    return list;
  }

  /**
   * Picks the machine-independent settings that travel inside a rules file.
   * (`enabled` is deliberately not portable: it is a per-machine on/off switch.)
   * @param {object} settings
   * @returns {{surfaces: object, disabledSites: string[]}}
   */
  function portableSettings(settings) {
    const s = sanitizeSettings(settings);
    return { surfaces: s.surfaces, disabledSites: s.disabledSites };
  }

  /**
   * Builds the portable JSON object used by Export and by extension/rules.json.
   * @param {object} settings
   * @returns {object}
   */
  function toPortable(settings) {
    const s = sanitizeSettings(settings);
    return {
      format: PORTABLE_FORMAT,
      version: PORTABLE_VERSION,
      rules: s.rules.map(({ from, to, match, enabled }) => ({ from, to, match, enabled })),
      settings: portableSettings(s),
    };
  }

  /**
   * Parses a rules file. Accepts the portable format, a plain array of rules, or a simple
   * { "find": "replacement" } map (handy for hand-editing).
   * @param {string|object} input JSON text or already-parsed value
   * @returns {{rules: object[], settings: object|null, skipped: number}}
   * @throws {Error} when the input is not valid JSON or not a recognised shape
   */
  function parsePortable(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    let rawRules;
    let settings = null;
    if (Array.isArray(data)) {
      rawRules = data;
    } else if (data && typeof data === 'object' && Array.isArray(data.rules)) {
      if (data.format && data.format !== PORTABLE_FORMAT) throw new Error(`Unknown format "${data.format}"`);
      rawRules = data.rules;
      if (data.settings && typeof data.settings === 'object') settings = portableSettings(data.settings);
    } else if (data && typeof data === 'object' && Object.values(data).every((v) => typeof v === 'string')) {
      rawRules = Object.entries(data).map(([from, to]) => ({ from, to }));
    } else {
      throw new Error('Not a Word Replacer rules file');
    }
    const rules = sanitizeRules(rawRules.map((r) => ({ ...r, id: '' })));
    return { rules, settings, skipped: rawRules.length - rules.length };
  }

  /**
   * SHA-256 hex digest of a string (used to notice when the bundled rules.json changed).
   * @param {string} text
   * @returns {Promise<string>}
   */
  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Reads and parses the rules.json file shipped inside the extension folder.
   * @returns {Promise<{hash: string, parsed: ReturnType<typeof parsePortable>}>}
   */
  async function fetchBundledRules() {
    const res = await fetch(chrome.runtime.getURL('rules.json'), { cache: 'no-store' });
    if (!res.ok) throw new Error(`rules.json: HTTP ${res.status}`);
    const text = await res.text();
    return { hash: await sha256Hex(text), parsed: parsePortable(text) };
  }

  return Object.freeze({
    STORAGE_KEY,
    BUNDLED_HASH_KEY,
    SCHEMA_VERSION,
    PORTABLE_FORMAT,
    SURFACE_KEYS,
    defaultSettings,
    makeRuleId,
    normalizeSite,
    matchingSites,
    isSiteDisabled,
    setSiteDisabled,
    sanitizeRules,
    sanitizeSettings,
    hasStoredSettings,
    loadSettings,
    saveSettings,
    updateSettings,
    upsertRule,
    mergeRules,
    portableSettings,
    toPortable,
    parsePortable,
    sha256Hex,
    fetchBundledRules,
  });
});
