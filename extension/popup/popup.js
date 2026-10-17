/**
 * popup.js — Logic of the toolbar popup.
 *
 * Purpose: show/toggle the global switch and "active on this site", show how many replacements
 * the current tab has (from the background worker's badge data) and open the options page.
 * For automated tests the target tab can be given as popup.html?tabId=<id>.
 */
(() => {
  'use strict';

  const Settings = globalThis.WRSettings;
  const $ = (id) => document.getElementById(id);

  let tab = null;
  let hostname = '';

  /** Resolves the tab the popup is about (active tab, or ?tabId= for tests). */
  async function resolveTab() {
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    if (forced) return chrome.tabs.get(forced);
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active || null;
  }

  /** Hostname for http(s) pages, '' for pages extensions cannot change or disable per site. */
  function hostnameOf(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
    } catch (_) {
      return '';
    }
  }

  /** Renders switches and texts from the current settings. */
  function render(settings) {
    $('enabled').checked = settings.enabled;
    const siteRow = $('siteRow');
    const note = $('siteNote');
    note.hidden = true;
    if (hostname) {
      const site = hostname.replace(/^www\./, '');
      const covering = Settings.matchingSites(settings, hostname);
      $('siteLabel').textContent = `Active on ${site}`;
      $('siteActive').checked = covering.length === 0;
      $('siteActive').disabled = false;
      siteRow.classList.remove('disabled');
      // Explain when a broader entry (e.g. "google.com" for mail.google.com) turns this site off.
      const others = covering.filter((entry) => entry !== Settings.normalizeSite(hostname));
      if (others.length) {
        note.textContent = `Off here because “${others.join('”, “')}” is in your disabled sites. Turning it on removes that entry.`;
        note.hidden = false;
      }
    } else {
      $('siteLabel').textContent = 'Active on this site';
      $('siteActive').checked = false;
      $('siteActive').disabled = true;
      siteRow.classList.add('disabled');
    }
    const activeRules = settings.rules.filter((r) => r.enabled).length;
    $('rulesInfo').textContent = `${activeRules} active rule${activeRules === 1 ? '' : 's'} · ${settings.rules.length} total`;
  }

  /** Asks the background worker for the tab's replacement count and shows it. */
  async function renderCount(settings) {
    const el = $('count');
    if (!tab || !/^(https?|file):/i.test(tab.url || '')) {
      el.textContent = 'This page cannot be changed by extensions.';
      return;
    }
    if (!settings.enabled) {
      el.textContent = 'Paused everywhere';
      return;
    }
    if (hostname && Settings.isSiteDisabled(settings, hostname)) {
      el.textContent = 'Paused on this site';
      return;
    }
    let status = null;
    try {
      status = await chrome.runtime.sendMessage({ type: 'wr:get-tab-status', tabId: tab.id });
    } catch (_) {
      /* worker waking up */
    }
    const total = status ? status.total : 0;
    el.textContent = `${total} replacement${total === 1 ? '' : 's'} on this page`;
  }

  /** Refreshes everything from storage. */
  async function refresh() {
    const settings = await Settings.loadSettings();
    render(settings);
    await renderCount(settings);
  }

  /** Wires up the controls. */
  async function init() {
    tab = await resolveTab();
    hostname = tab ? hostnameOf(tab.url) : '';

    $('enabled').addEventListener('change', (e) => {
      const on = e.target.checked;
      Settings.updateSettings((s) => {
        s.enabled = on;
      });
    });

    $('siteActive').addEventListener('change', (e) => {
      const on = e.target.checked;
      Settings.updateSettings((s) => {
        s.disabledSites = Settings.setSiteDisabled(s.disabledSites, hostname, !on);
      });
    });

    $('openOptions').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[Settings.STORAGE_KEY]) {
        refresh();
        setTimeout(refresh, 600); // content scripts re-report shortly after applying settings
      }
    });

    await refresh();
    // Two frames later: the switches' initial state is painted without animating from "off".
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ready')));
  }

  init();
})();
