/**
 * options.js — Logic of the options page.
 *
 * Purpose: edit rules (find / replace with / match mode / on-off), choose where replacements
 * apply, manage disabled sites, export/import rules files and import the bundled
 * extension/rules.json (with a banner when it changed, e.g. after `git pull` + reload).
 * Saves automatically (debounced). Saves are merge-safe: rules added meanwhile elsewhere
 * (context menu, another options tab) are kept, not overwritten.
 */
(() => {
  'use strict';

  const Engine = globalThis.WREngine;
  const Settings = globalThis.WRSettings;
  const $ = (id) => document.getElementById(id);
  const SAVE_DELAY_MS = 400;

  /** Rules as shown in the table (may include rows that are not valid yet). */
  let uiRules = [];
  /** Rules as last synced with storage: the common base for three-way merging on save. */
  let baseRules = [];
  let lastSavedRulesJson = '';
  /** Last known stored settings (for the synchronous save on unload). */
  let cachedSettings = null;
  let saveTimer = 0;
  let saving = false;
  let statusTimer = 0;

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------

  /** Shows a short status message in the header. */
  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', Boolean(isError));
    clearTimeout(statusTimer);
    if (text && !isError) statusTimer = setTimeout(() => (el.textContent = ''), 2500);
  }

  /** Creates an empty rule for a new table row. */
  function newRule(from) {
    return { id: Settings.makeRuleId(), from: from || '', to: '', match: Engine.DEFAULT_MATCH, enabled: true };
  }

  /** True when a table row can be saved (valid "Find" etc.). */
  function isSavable(rule) {
    return !Engine.validateRule(Engine.normalizeRule(rule));
  }

  /** Rules from the table that are valid and can be saved. */
  function savableRules() {
    return uiRules.filter(isSavable);
  }

  /** Same visible content (ignoring ids). */
  function sameRule(a, b) {
    return a.from === b.from && a.to === b.to && a.match === b.match && a.enabled === b.enabled;
  }

  /**
   * Three-way merge of this page's table with what is stored now, relative to `base` (the state the
   * table was last synced with): edits and deletions made here win for rules this page knew;
   * rules added, changed or removed elsewhere meanwhile (popup, context menu, another tab, an import)
   * are respected; rules added here are appended.
   */
  function mergeRulesForSave(base, ui, stored) {
    const baseById = new Map(base.map((r) => [r.id, r]));
    const uiById = new Map(ui.map((r) => [r.id, r]));
    const storedIds = new Set(stored.map((r) => r.id));
    const out = [];
    for (const r of stored) {
      const b = baseById.get(r.id);
      if (!b) {
        out.push(r); // added elsewhere
        continue;
      }
      const u = uiById.get(r.id);
      if (!u) continue; // deleted here
      out.push(sameRule(Engine.normalizeRule(u), b) ? r : u); // edited here wins, else keep stored
    }
    for (const u of ui) if (!baseById.has(u.id) && !storedIds.has(u.id)) out.push(u); // added here
    return out;
  }

  /**
   * Makes `rules` (just saved or changed in storage) the new sync base and shows them, keeping
   * rows the user is typing in (when they normalize to the same rule) and unsaved invalid rows.
   */
  function adoptStoredRules(rules) {
    baseRules = rules.map((r) => ({ ...r }));
    lastSavedRulesJson = JSON.stringify(rules);
    const uiById = new Map(uiRules.map((r) => [r.id, r]));
    const pendingInvalid = uiRules.filter((r) => !isSavable(r));
    const next = rules
      .map((r) => {
        const u = uiById.get(r.id);
        return u && sameRule(Engine.normalizeRule(u), r) ? u : { ...r };
      })
      .concat(pendingInvalid);
    const changed = next.length !== uiRules.length || next.some((r, i) => r !== uiRules[i]);
    uiRules = next;
    if (changed) renderRules();
  }

  // ---------------------------------------------------------------------------------------------
  // Rules table
  // ---------------------------------------------------------------------------------------------

  /** Re-renders the rules table from `uiRules`, keeping keyboard focus where it was. */
  function renderRules() {
    const active = document.activeElement;
    const focusRow = active && active.closest && active.closest('tr[data-id]');
    const focus = focusRow
      ? { id: focusRow.dataset.id, cls: active.className, start: active.selectionStart, end: active.selectionEnd }
      : null;

    const tbody = $('rules');
    tbody.textContent = '';
    const tpl = $('ruleRow');
    for (const rule of uiRules) {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.id = rule.id;
      row.querySelector('.r-enabled').checked = rule.enabled;
      row.querySelector('.r-from').value = rule.from;
      row.querySelector('.r-to').value = rule.to;
      row.querySelector('.r-match').value = rule.match;
      tbody.appendChild(row);
    }
    updateRowStates();
    applyFilter();

    if (focus) {
      const el = tbody.querySelector(`tr[data-id="${CSS.escape(focus.id)}"] .${focus.cls.split(' ')[0]}`);
      if (el) {
        el.focus();
        if (typeof focus.start === 'number' && el.setSelectionRange) el.setSelectionRange(focus.start, focus.end);
      }
    }
  }

  /** Marks invalid/duplicate/disabled rows and updates the summary line. */
  function updateRowStates() {
    const seen = new Map();
    let invalid = 0;
    let duplicates = 0;
    for (const row of $('rules').rows) {
      const rule = uiRules.find((r) => r.id === row.dataset.id);
      if (!rule) continue;
      const problem = Engine.validateRule(Engine.normalizeRule(rule));
      const key = Engine.ruleKey(rule.from);
      const dup = !problem && seen.has(key);
      if (!problem && !dup) seen.set(key, row);
      row.classList.toggle('invalid', Boolean(problem) && rule.from.trim() !== '');
      row.classList.toggle('duplicate', dup);
      row.classList.toggle('disabled-rule', !rule.enabled);
      const from = row.querySelector('.r-from');
      from.title = problem ? `Not saved: ${problem}` : dup ? 'Duplicate — only the first rule with this text is used' : '';
      if (problem) invalid++;
      if (dup) duplicates++;
    }
    const active = uiRules.filter((r) => r.enabled && !Engine.validateRule(Engine.normalizeRule(r))).length;
    const parts = [`${uiRules.length} rule${uiRules.length === 1 ? '' : 's'}, ${active} active`];
    if (invalid) parts.push(`${invalid} not saved (empty or invalid “Find”)`);
    if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} ignored`);
    $('rulesSummary').textContent = parts.join(' · ');
    $('rulesEmpty').hidden = uiRules.length > 0;
  }

  /** Hides rows that do not contain the filter text. */
  function applyFilter() {
    const q = $('filter').value.trim().toLowerCase();
    for (const row of $('rules').rows) {
      const text = `${row.querySelector('.r-from').value}\n${row.querySelector('.r-to').value}`.toLowerCase();
      row.hidden = q !== '' && !text.includes(q);
    }
  }

  /** Handles edits inside the table (event delegation). */
  function onTableEdit(e) {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const rule = uiRules.find((r) => r.id === row.dataset.id);
    if (!rule) return;
    const t = e.target;
    if (!t.isConnected) return; // late "change" from an input removed by a re-render
    if (t.classList.contains('r-from')) rule.from = t.value;
    else if (t.classList.contains('r-to')) rule.to = t.value;
    else if (t.classList.contains('r-match')) rule.match = t.value;
    else if (t.classList.contains('r-enabled')) rule.enabled = t.checked;
    else return;
    updateRowStates();
    scheduleSave();
  }

  /** Handles the delete buttons in the table. */
  function onTableClick(e) {
    const btn = e.target.closest('.r-delete');
    if (!btn) return;
    const id = btn.closest('tr[data-id]').dataset.id;
    uiRules = uiRules.filter((r) => r.id !== id);
    renderRules();
    scheduleSave();
  }

  /** Adds an empty row (or focuses the existing rule for `from`) and focuses the right input. */
  function addRule(from) {
    const existing = from ? uiRules.find((r) => Engine.ruleKey(r.from) === Engine.ruleKey(from)) : null;
    const rule = existing || newRule(from);
    if (!existing) uiRules.push(rule);
    $('filter').value = '';
    renderRules();
    const row = $('rules').querySelector(`tr[data-id="${CSS.escape(rule.id)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.querySelector(from ? '.r-to' : '.r-from').focus();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------------------------

  /** Debounces saving while typing. */
  function scheduleSave() {
    clearTimeout(saveTimer);
    setStatus('Saving…');
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      saveRules();
    }, SAVE_DELAY_MS);
  }

  /** Saves pending table edits immediately (used before imports). */
  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
      await saveRules();
    }
  }

  /** Saves the valid table rules, merged with changes made elsewhere in the meantime. */
  async function saveRules() {
    saving = true;
    try {
      const ui = savableRules();
      const saved = await Settings.updateSettings((s) => {
        s.rules = mergeRulesForSave(baseRules, ui, s.rules);
      });
      cachedSettings = saved;
      adoptStoredRules(saved.rules);
      setStatus('Saved ✓');
    } catch (e) {
      setStatus(`Save failed: ${e.message}`, true);
    } finally {
      saving = false;
    }
  }

  /**
   * Last-chance synchronous save when the page closes during the debounce: an async
   * read-modify-write would not finish before unload, so the result is built from the in-memory
   * copy of the settings (kept current by onStorageChanged) and written immediately.
   */
  function saveNowSync() {
    if (!saveTimer || !cachedSettings) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    const rules = mergeRulesForSave(baseRules, savableRules(), cachedSettings.rules);
    const next = Settings.sanitizeSettings({ ...cachedSettings, rules });
    chrome.storage.local.set({ [Settings.STORAGE_KEY]: next });
  }

  // ---------------------------------------------------------------------------------------------
  // Other settings
  // ---------------------------------------------------------------------------------------------

  /** Renders the global switch, surfaces and disabled sites. */
  function renderSettings(s) {
    $('enabled').checked = s.enabled;
    for (const box of document.querySelectorAll('[data-surface]')) box.checked = Boolean(s.surfaces[box.dataset.surface]);
    const list = $('sites');
    list.textContent = '';
    for (const site of s.disabledSites) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = site;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Enable again';
      btn.dataset.site = site;
      li.append(name, btn);
      list.appendChild(li);
    }
    $('sitesEmpty').hidden = s.disabledSites.length > 0;
  }

  /** Saves a single settings change and reports the result. */
  async function saveField(mutator) {
    try {
      cachedSettings = await Settings.updateSettings(mutator);
      setStatus('Saved ✓');
    } catch (e) {
      setStatus(`Save failed: ${e.message}`, true);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------------------------------

  /** Downloads the current rules + portable settings as rules.json. */
  async function exportRules() {
    await flushSave();
    const data = Settings.toPortable(await Settings.loadSettings());
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rules.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    setStatus(`Exported ${data.rules.length} rules`);
  }

  /**
   * Applies a parsed rules file. merge: rules upserted, disabled sites added;
   * replace: rules (and surfaces/disabled sites, when present in the file) replaced.
   */
  async function applyImport(parsed, mode) {
    await flushSave();
    const saved = await Settings.updateSettings((s) => {
      if (mode === 'replace') {
        s.rules = parsed.rules;
        if (parsed.settings) {
          s.surfaces = parsed.settings.surfaces;
          s.disabledSites = parsed.settings.disabledSites;
        }
      } else {
        s.rules = Settings.mergeRules(s.rules, parsed.rules);
        if (parsed.settings) s.disabledSites = [...new Set(s.disabledSites.concat(parsed.settings.disabledSites))];
      }
    });
    loadIntoUi(saved);
    const skipped = parsed.skipped ? `, ${parsed.skipped} invalid skipped` : '';
    $('importResult').textContent = `${mode === 'replace' ? 'Replaced with' : 'Merged'} ${parsed.rules.length} rules${skipped}. You now have ${saved.rules.length} rules.`;
    setStatus('Imported ✓');
  }

  /** Imports the file chosen in the file input. */
  async function importFile(file) {
    try {
      const parsed = Settings.parsePortable(await file.text());
      await applyImport(parsed, $('importMode').value);
    } catch (e) {
      $('importResult').textContent = `Import failed: ${e.message}`;
      setStatus('Import failed', true);
    }
  }

  /** Imports the bundled extension/rules.json and remembers its hash. */
  async function importBundled(mode) {
    try {
      const bundled = await Settings.fetchBundledRules();
      if (mode !== 'ignore') await applyImport(bundled.parsed, mode);
      await chrome.storage.local.set({ [Settings.BUNDLED_HASH_KEY]: bundled.hash });
      $('bundledBanner').hidden = true;
    } catch (e) {
      showBundledError(e);
      $('importResult').textContent = `Could not read extension/rules.json: ${e.message}`;
      setStatus('Import failed', true);
    }
  }

  /** Shows the banner when extension/rules.json differs from the version last imported. */
  async function checkBundled() {
    try {
      const [bundled, stored] = await Promise.all([
        Settings.fetchBundledRules(),
        chrome.storage.local.get(Settings.BUNDLED_HASH_KEY),
      ]);
      $('bundledBanner').hidden = stored[Settings.BUNDLED_HASH_KEY] === bundled.hash;
      $('bundledError').hidden = true;
    } catch (e) {
      $('bundledBanner').hidden = true;
      showBundledError(e);
    }
  }

  /** Explains a broken extension/rules.json (typically a typo after editing it by hand). */
  function showBundledError(e) {
    const el = $('bundledError');
    el.textContent =
      `⚠ extension/rules.json has a mistake and cannot be used: ${e.message}. ` +
      'Fix the file (each line looks like "word": "replacement", with commas between lines), ' +
      'then reload the extension in vivaldi://extensions.';
    el.hidden = false;
  }

  // ---------------------------------------------------------------------------------------------
  // "See the difference" box
  // ---------------------------------------------------------------------------------------------

  const MARK_OPEN = '\uE000';
  const MARK_CLOSE = '\uE001';
  const COMPARE_CELLS = [
    ['anywhere', 'cmpAnywhere'],
    ['wordStart', 'cmpWordStart'],
    ['wholeWord', 'cmpWholeWord'],
  ];

  /** Shows the example text as each match mode would change it (replacements highlighted). */
  function renderCompare() {
    const from = $('cmpFrom').value;
    const to = $('cmpTo').value.replace(/[\uE000\uE001]/g, '');
    const text = $('cmpText').value;
    for (const [mode, id] of COMPARE_CELLS) {
      const compiled = Engine.compileRules([{ from, to: MARK_OPEN + to + MARK_CLOSE, match: mode }]);
      const out = compiled ? Engine.replaceText(compiled, text).text : text;
      const cell = $(id);
      cell.textContent = '';
      // Build text + <mark> nodes (never innerHTML): markers delimit each replacement.
      for (const [i, part] of out.split(new RegExp(`[${MARK_OPEN}${MARK_CLOSE}]`)).entries()) {
        if (i % 2 === 1) {
          const mark = document.createElement('mark');
          mark.textContent = part;
          cell.appendChild(mark);
        } else if (part) {
          cell.appendChild(document.createTextNode(part));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------------------------

  /** Replaces the whole UI state with saved settings. */
  function loadIntoUi(s) {
    cachedSettings = s;
    uiRules = s.rules.map((r) => ({ ...r }));
    baseRules = s.rules.map((r) => ({ ...r }));
    lastSavedRulesJson = JSON.stringify(s.rules);
    renderRules();
    renderSettings(s);
  }

  /** Keeps the page in sync with changes made by the popup, context menu or other tabs. */
  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes[Settings.STORAGE_KEY]) return;
    const s = Settings.sanitizeSettings(changes[Settings.STORAGE_KEY].newValue);
    cachedSettings = s;
    renderSettings(s);
    if (saving || saveTimer) return; // our own save, or edits pending (merged on save)
    const json = JSON.stringify(s.rules);
    if (json === lastSavedRulesJson) return;
    adoptStoredRules(s.rules);
  }

  /** Handles options.html#add=<word> (context-menu fallback): adds/focuses that rule. */
  function handleHash() {
    const m = /^#add=(.+)$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    addRule(decodeURIComponent(m[1]));
  }

  /** Entry point: load settings, render, wire up events. */
  async function init() {
    loadIntoUi(await Settings.loadSettings());

    $('rules').addEventListener('input', onTableEdit);
    $('rules').addEventListener('change', onTableEdit);
    $('rules').addEventListener('click', onTableClick);
    $('addRule').addEventListener('click', () => addRule(''));
    $('filter').addEventListener('input', applyFilter);

    $('enabled').addEventListener('change', (e) => saveField((s) => void (s.enabled = e.target.checked)));
    for (const box of document.querySelectorAll('[data-surface]')) {
      box.addEventListener('change', () => saveField((s) => void (s.surfaces[box.dataset.surface] = box.checked)));
    }
    $('siteForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const site = Settings.normalizeSite($('siteInput').value);
      if (!site) {
        setStatus('Enter a site like example.com', true);
        return;
      }
      $('siteInput').value = '';
      saveField((s) => {
        if (!s.disabledSites.includes(site)) s.disabledSites.push(site);
      });
    });
    $('sites').addEventListener('click', (e) => {
      const site = e.target.dataset && e.target.dataset.site;
      if (site) saveField((s) => void (s.disabledSites = s.disabledSites.filter((x) => x !== site)));
    });

    for (const id of ['cmpFrom', 'cmpTo', 'cmpText']) $(id).addEventListener('input', renderCompare);
    renderCompare();

    $('exportBtn').addEventListener('click', exportRules);
    $('importFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importFile(file);
    });
    $('loadBundled').addEventListener('click', () => importBundled($('importMode').value));
    $('bundledBanner').addEventListener('click', (e) => {
      const mode = e.target.dataset && e.target.dataset.bundled;
      if (mode) importBundled(mode);
    });

    chrome.storage.onChanged.addListener(onStorageChanged);
    window.addEventListener('hashchange', handleHash);
    window.addEventListener('pagehide', saveNowSync);
    window.addEventListener('beforeunload', saveNowSync);

    handleHash();
    checkBundled();
    // Two frames later: the switches' initial state is painted without animating from "off".
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ready')));
  }

  init();
})();
