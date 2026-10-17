# Word Replacer — technical reference (for AI agents)

> **This file is for AI agents and developers.** It is not a user guide. The human guide is
> [MANUAL.md](MANUAL.md): keep it short and simple, and update it whenever UI labels or the
> install steps change.

## 1. What this is

- A personal **Chromium Manifest V3 extension** for Vivaldi (verified on Vivaldi 8.2 / Chromium
  152). It also works in Chrome, Edge and Brave.
- It **visually replaces configured words on every web page** (case-insensitive). Each rule is
  `{ from, to, match, enabled }`. Users add their own words after installing.
- There is no build step, no runtime dependencies and no network access. The extension is loaded
  unpacked from `extension/`, with **Developer mode** on.
- Pinned extension ID: `cjaaplbkmdlkoaaonecnomdahnifbdpj`. It comes from the public `key` in
  `manifest.json`; no private key exists or is needed.
- Works on any frontend: static pages, React/Vue/Angular/Svelte SPAs, SSR hydration, open and
  closed shadow DOM, all iframe kinds, and streamed HTML.

## 2. Rules for agents working on this repo

1. **No personal words in the repo.**
   - `extension/rules.json` ships only the 3 neutral example rules, one per match mode, all
     **switched off**: `color→colour` (anywhere), `organize→organise` (wordStart),
     `gray→grey` (wholeWord).
   - Tests and docs use neutral words only (apple/banana/color/cat…).
   - Never commit a user's real rule list.
2. **Documentation convention.**
   - Every file starts with a comment stating its purpose, and every function has a doc comment.
   - Keep the code map ([§10](#10-code-map)) in sync: add new functions and remove deleted ones.
3. **The manual stays short.** `MANUAL.md` covers install and use only. Technical detail goes here.
4. **Keep these invariants** (all covered by tests; see §4–§7):
   - Only edit `Text.data` and a few display attributes, **in place**. Never wrap, insert or
     remove page nodes.
   - Never modify `<script>`, `<style>`, `<noscript>`, `<template>`, `<textarea>`, input values,
     contenteditable regions, `designMode` documents, the value of a *named* submit button, or
     the submitted value of an `<option>`.
   - The default match mode is **`anywhere`** (`Engine.DEFAULT_MATCH`).
   - A user's settings are never overwritten without an explicit action: seeding happens only on
     first install, and the `rules.json` banner only acts on a click.
5. **Windows scripts** (`*.cmd`, `*.ps1`) must stay **ASCII-only with CRLF line endings**, because
   Windows PowerShell 5.1 misreads non-ASCII in BOM-less files. `.gitattributes` enforces CRLF for
   `*.cmd`/`*.ps1` and LF for `*.sh`.
6. **Commits:**
   - Use the repo-local identity `xrta93 <xrta93@users.noreply.github.com>`.
   - Add the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
7. **Before committing,** run `npm run test:all`. On a WSL machine with Vivaldi, also run
   `npm run test:vivaldi`.

## 3. Install / operate (what the user does)

| Step | How |
|---|---|
| Build the loadable folder | **Windows:** double-click `make-extension-windows.cmd` (runs `scripts/make-extension-windows.ps1`). **Ubuntu/WSL:** `bash make-extension-ubuntu.sh`. |
| Script output | `<out>/word-replacer-extension.zip` (the extension files at the zip root, `/` separators) and `<out>/word-replacer/` (extracted, plus the marker `DEPLOYED-BY-WORD-REPLACER.txt`). The script prints both paths and copies the folder path to the clipboard. |
| Default `<out>` | Windows: `%USERPROFILE%\VivaldiExtensions`. WSL: the same Windows folder via `/mnt/c/...`. Native Ubuntu: `~/VivaldiExtensions`. The first argument overrides it. |
| Script safety | Refuses an output that overlaps `extension/`. Refuses to replace a non-empty `word-replacer/` without the marker. Re-running replaces its own output cleanly. Test-only flags: `-NoClipboard` (ps1) and `WR_NO_CLIPBOARD=1` (sh). |
| Load | `vivaldi://extensions` → Developer mode on → **Load unpacked** → select the extracted folder. Chromium ≥ 137 cannot load from `\\wsl.localhost\…`, so on WSL the folder must be on a Windows drive; the sh script warns otherwise. |
| After code or `rules.json` changes | Re-run the script → **reload ⟳** on the extension card. Open tabs are re-injected automatically, and settings are kept. If `rules.json` changed, the options page shows a banner: **Merge into my rules** / **Replace my rules** / **Ignore**. |
| Other computers | Copy the zip → Extract All → Load unpacked. Rules travel via **Export rules (.json)** → **Import file…**. Vivaldi Sync does not sync extension data. |
| Publish (private repo) | `gh repo create vivaldi-word-replacer --private --source=. --remote=origin --push`, or add the remote `https://github.com/xrta93/vivaldi-word-replacer.git` and push `main`. |

**Troubleshooting:**

| Symptom | Fix |
|---|---|
| *Manifest file is missing or unreadable* | The wrong folder was selected. |
| *Could not load manifest* | The folder is on a WSL path; load the Windows copy instead. |
| Nothing replaced on a page | Check the popup switches and the rule's **On** box, and whether the page is restricted (§8). |
| Gone after a restart | Developer mode was turned off, or the folder was moved. |
| `file://` pages not replaced | Details → **Allow access to file URLs**. |

## 4. Data formats

- **Settings** live in `chrome.storage.local['wr.settings']`:
  ```json
  { "schemaVersion": 1, "enabled": true,
    "surfaces": { "title": true, "tooltips": true, "placeholders": true, "buttonLabels": true, "altText": true },
    "disabledSites": ["example.com"],
    "rules": [{ "id": "…", "from": "apple", "to": "A1", "match": "anywhere", "enabled": true }] }
  ```
  `sanitizeSettings` repairs any input: it fixes types, drops invalid rules, and fixes
  missing or duplicate ids.
- **Portable format** (Export, `extension/rules.json`):
  `{ "format": "vivaldi-word-replacer", "version": 1, "rules": [{from,to,match,enabled}], "settings": {surfaces, disabledSites} }`.
  - `parsePortable` also accepts a plain array of rules, or a map `{ "word": "replacement" }`
    (match = default).
  - `enabled` (the global switch) is never exported.
- **`wr.bundledRulesHash`** is the SHA-256 of the `rules.json` that was last seeded, imported or
  ignored. A mismatch shows the banner; an unparsable file shows a red error banner.
- **`chrome.storage.session['wr.tabCounts']`** holds badge counts per tab and frame.
- **Disabled sites** are hostnames without `www.`, and an entry covers its subdomains
  (`matchingSites`, `setSiteDisabled`).
  - The per-site switches are the popup's *Active on …* and the page context menu
    *Word Replacer: turn off/on for this site*.
  - Turning a site back on removes every entry that covers it. The popup explains when a broader
    entry is the cause.

## 5. Matching semantics (`extension/src/shared/engine.js`)

- **Matching:**
  - Case-insensitive (`giu` flags); the output is exactly `to`.
  - One regex is built from all enabled rules, **longest first**, applied in **one pass**, so
    replacements never chain. Duplicate `from` values (ignoring case): the first rule wins.
- **Modes:** `anywhere` (default), `wordStart` (leading boundary only), `wholeWord` (both boundaries).
  - Boundaries are lookarounds on `[\p{L}\p{M}\p{N}]`; JS `\b` is ASCII-only. They are applied
    only where the rule starts or ends with a letter (`C++`, `.NET`).
  - Example, rule `color→colour` on `color, Colors, watercolor, Colorado`:
    - anywhere → `colour, colours, watercolour, colourado`
    - wordStart → `colour, colours, watercolor, colourado`
    - wholeWord → `colour, Colors, watercolor, Colorado`
- **Text variations tolerated:**
  - Invisible characters inside words (U+00AD, U+200B–U+200D, U+2060, U+FEFF).
  - Any whitespace inside a phrase. This is a single character class: an overlapping alternation
    would backtrack exponentially.
  - NFC normalization when a rule contains non-ASCII text (accents typed as combining marks still match).
- **Limits:** `from` ≤ 200 characters, `to` ≤ 500. An empty `to` deletes the word.

## 6. Runtime design

- **Content script** (`content.js`, isolated world, `document_start`, all frames,
  `match_about_blank`, `match_origin_as_fallback`):
  - One MutationObserver (childList, characterData with `characterDataOldValue`, a filtered set
    of attributes) watches the document and every shadow root.
  - Callbacks run before paint. The extension's own writes are skipped by a WeakMap check
    (`rec.replaced === data`); `takeRecords()` is not used.
  - Records `{original, replaced, count, gen}` live in WeakMaps. Settings changes bump `gen` and
    restore all connected nodes. Detached nodes keep their record and are restored or updated
    when re-inserted; while paused, the observer stays on if anything was ever replaced.
- **Pages that change replaced text:**
  - **Streaming/appended text:** if the old value equals `rec.replaced` and the page appended or
    prepended to it, the true original is rebuilt first (`extendedBase`).
  - **Fight guard:** more than 100 rewrites per second on the same parent → stop touching it.
- **Editable areas:**
  - When an element gains `contenteditable`, its subtree is restored.
  - On `focusin` or `beforeinput`, the editing host is restored first.
  - When the document switches to `designMode`, everything is restored and processing stops.
- **Option values:** `syncOption` pins `value` to the original text while an option's label is
  replaced, follows later text changes, and removes the pin when nothing is replaced.
- **Shadow DOM:**
  - Roots are found with `chrome.dom.openOrClosedShadowRoot`, which also works for closed roots.
  - `shadow-hook.js` (MAIN world) wraps `attachShadow` in a transparent Proxy and dispatches an
    event: a composed event from connected hosts, or a document `MouseEvent` with `relatedTarget`
    for detached hosts.
  - After `load`, an idle deep scan finds closed declarative roots on built-in elements.
- **Lifecycle:**
  - The `wr:content-instance-v1` event makes an older instance (from before an extension reload)
    restore its changes and stop.
  - An orphaned instance restores the page when `chrome.runtime.id` disappears.
- **Background worker** (`background.js`, classic SW with `importScripts`):
  - Seeds settings on first install; injects into open tabs on install/update.
  - Context menus: *Replace “%s” with…* (selection; a `prompt()` in the top frame, falling back
    to options `#add=word`) and the per-site switch (page/frame, http/https only).
  - Badge: the sum of per-frame counts, or `off`. A top-frame `wr:hello` resets the tab's counts.
- **Options page:**
  - Debounced autosave as a **three-way merge** against the last synced base, so concurrent
    changes elsewhere are respected.
  - Synchronous save on `pagehide`; import/export; the banner and the red error banner.
  - The **See the difference** box (`renderCompare`) shows one example under all three modes,
    with `<mark>` highlights built from private-use markers (no `innerHTML`).
- **Popup:** the global switch, the per-site switch with the parent-entry note, and the count.
  Switch animations are enabled only after the first render.

## 7. Development & testing

```bash
npm install                                  # dev tools only (Playwright, React/Lit fixtures, esbuild)
npx playwright install --with-deps chromium  # once
npm test              # unit: engine, settings, both make-extension scripts (Windows part needs WSL)
npm run test:e2e      # Playwright Chromium + extension: 36 scenarios (page behaviour, UI, rules.json)
npm run test:all      # both
npm run test:vivaldi  # real Vivaldi on Windows from WSL, throwaway profile + own rules.json, headless
npm run icons         # regenerate extension/icons/*.png
```

- **E2E fixtures** are served by `test/e2e/harness.js` on two origins, with React/Lit bundled by
  esbuild into `test/e2e/.build/` (git-ignored). Special routes: SSR at `/react-ssr.html`,
  chunked streaming at `/stream.html`, and `POST /report`.
- **The smoke test:**
  - Copies the extension (with a test `rules.json`) and a pre-seeded profile into
    `%LOCALAPPDATA%\Temp`. Without seeding, Vivaldi's first-run onboarding blocks the start URL.
  - Starts `vivaldi.exe --headless=new --load-extension=…`; set `WR_SMOKE_HEADED=1` for a window.
  - Reads results the page `POST`s back.
  - Stops only its own PIDs and deletes the temp folders.

## 8. Limits (cannot be changed by any extension)

- Canvas-rendered text (Google Docs/Sheets, Figma, Flutter, WebGL).
- Text in images or videos, and native WebVTT captions.
- The address bar URL and Vivaldi's own UI (tab titles **are** covered).
- The built-in PDF viewer, `vivaldi://`/`chrome://` pages, the Web Store and other extensions' pages.
- OS notifications from service workers.
- CSS `::before { content }`.
- Words split across tags (`<b>app</b>le`).

## 9. Side effects to expect

- Copy/paste, Ctrl+F, translation, printing and bookmark/history titles all see the replaced text.
- Layout may shift where the length of a word changes.
- SSR hydration mismatches are recovered by React itself.

## 10. Code map

### Root

| File | Purpose |
|---|---|
| `MANUAL.md` | Short human guide (install + use). |
| `README.md` | This AI/developer reference. |
| `make-extension-windows.cmd` | Double-click launcher for `scripts/make-extension-windows.ps1` (ends with `pause`). |
| `make-extension-ubuntu.sh` | Ubuntu/WSL builder: zip + extract + print the location (bash + python3). |
| ↳ `fail` / `is_wsl` / `default_out` / `show_path` | Error exit, WSL detection, default output folder, Windows-style path display in WSL. |
| `.gitattributes` | CRLF for `*.cmd`/`*.ps1`, LF for `*.sh`. |
| `package.json` | Dev scripts: `test`, `test:e2e`, `test:all`, `test:vivaldi`, `icons`. |

### `extension/` — the folder Vivaldi loads

| File | Purpose |
|---|---|
| `manifest.json` | MV3: pinned `key`; permissions `storage`, `scripting`, `contextMenus`; host `<all_urls>`; content scripts in both worlds for all frames; popup; options page. |
| `rules.json` | The 3 neutral example rules (switched off); seeds a first install. |
| `icons/icon{16,32,48,128}.png` | Generated by `scripts/make-icons.mjs`. |
| `popup/popup.html`, `popup.css` | Popup markup and styles. |
| `options/options.html`, `options.css` | Options page markup and styles. |

**`src/shared/engine.js`** — the pure matcher (UMD: `globalThis.WREngine`, or `module.exports`).

| Function | Purpose |
|---|---|
| `normalizeFrom(from)` | NFC, remove invisible characters, collapse whitespace, trim. |
| `ruleKey(from)` | Case-insensitive duplicate key. |
| `normalizeRule(raw)` | Coerce to `{id, from, to, match, enabled}` with defaults (match = `anywhere`). |
| `validateRule(rule)` | Problem text, or `null`. |
| `escapeChar(ch)` | Escape one regex syntax character (`u` flag). |
| `buildRulePattern(from, match)` | Regex source for one rule (boundaries per mode, invisible characters, phrase spaces). |
| `compileRules(rules)` | One case-insensitive, longest-first regex plus `minLength`, `needsNFC` and `signature`; `null` if no rule is active. |
| `replaceText(compiled, text)` | Single-pass replacement → `{text, count}`. |

**`src/shared/settings.js`** — schema, storage, portable format (`globalThis.WRSettings`, or `module.exports`).

| Function | Purpose |
|---|---|
| `defaultSettings()` | Fresh defaults. |
| `makeRuleId()` | Unique rule id. |
| `normalizeSite(input)` | URL/hostname → site key (lowercase, no `www.`/port/path), or `''`. |
| `matchingSites(settings, host)` | Disabled-site entries covering a host. |
| `isSiteDisabled(settings, host)` | Whether any entry covers the host. |
| `setSiteDisabled(list, host, disabled)` | Turn a site off (add unless already covered) or on (remove covering entries). |
| `sanitizeRules(rules)` / `sanitizeSettings(raw)` | Repair rules / complete settings. |
| `hasStoredSettings()` / `loadSettings()` / `saveSettings(s)` / `updateSettings(mutator)` | Storage access (read-modify-write helper). |
| `upsertRule(rules, rule)` / `mergeRules(existing, incoming)` | Add-or-update by find text / import merge. |
| `portableSettings(s)` / `toPortable(s)` / `parsePortable(input)` | Export/import format. |
| `sha256Hex(text)` / `fetchBundledRules()` | Bundled `rules.json` reading and hashing. |

**`src/shadow-hook.js`** (MAIN world): `notify(host)` reports a new shadow root. The Proxy `apply`/`get` traps wrap `attachShadow` transparently and mark it so it isn't hooked twice.

**`src/content.js`** — the DOM layer.

| Function | Purpose |
|---|---|
| `contextAlive()` / `topSiteHostname()` | Extension still loaded? / top-level site for frames. |
| `buildExcludedSelector(s)` / `closestAcrossShadow(node, sel)` / `allowedContext(parent)` | Where rewriting is allowed. |
| `isEditableRoot(el)` / `isSkippedElement(el)` | Editable regions / skipped subtrees. |
| `getShadowRoot(el)` | Open or closed root (closed only for likely hosts). |
| `isContested(parent)` | The fight guard. |
| `attributeAllowed(el, name)` | Display-attribute rules (named submit buttons excluded). |
| `optionOriginalText(option)` / `syncOption(option)` | Keep an `<option>`'s submitted value as its original text. |
| `extendedBase(node, oldValue)` | Rebuild the original after appends to rewritten text. |
| `processText` / `processAttr` / `processAttributes` / `processTree` | Replace (or restore stale) text, attributes, subtrees. |
| `adoptRoot` / `discoverRoots` / `scheduleDeepScan` / `forEachRoot` | Shadow-root handling. |
| `restoreNode` / `restoreIn` / `restoreSubtree` / `restoreAll` | Restore originals. |
| `countAll` / `reportCount` / `scheduleCount` / `send` | Badge counts. |
| `onMutations` / `onEditableChanged` / `onEditIntent` / `restoreForDesignMode` | Mutation and editing handling. |
| `onShadowEvent` / `onDetachedShadowEvent` / `onLoadRescan` / `onPageShow` | Events. |
| `applySettings` / `onStorageChanged` / `teardown` / `init` | Lifecycle. |

**`src/background.js`** — the service worker.

| Function | Purpose |
|---|---|
| `handleInstalled` / `seedSettingsIfMissing` / `createMenus` / `injectIntoOpenTabs` | Install/update. |
| `normalizeSelection` / `handleMenuClick` / `addOrUpdateRule` / `promptInTab` / `openOptions` | *Replace “%s” with…* flow. |
| `siteHostname` / `toggleSiteForTab` | Per-site context-menu switch. |
| `loadCounts` / `withCounts` / `tabTotal` / `formatCount` / `refreshBadge` / `onMessage` | Badge counts and messages. |

**`popup/popup.js`**: `resolveTab` (active tab, or `?tabId=` for tests), `hostnameOf`, `render` (switches, the parent-entry note), `renderCount`, `refresh`, `init`.

**`options/options.js`**:

| Function | Purpose |
|---|---|
| `setStatus` / `newRule` / `isSavable` / `savableRules` / `sameRule` | Helpers. |
| `mergeRulesForSave` / `adoptStoredRules` | Three-way merge with the stored rules. |
| `renderRules` / `updateRowStates` / `applyFilter` / `onTableEdit` / `onTableClick` / `addRule` | Rules table. |
| `scheduleSave` / `flushSave` / `saveRules` / `saveNowSync` | Autosave (and the save on unload). |
| `renderSettings` / `saveField` | Global switch, surfaces, disabled sites. |
| `exportRules` / `applyImport` / `importFile` / `importBundled` / `checkBundled` / `showBundledError` | Import/export and the `rules.json` banners. |
| `renderCompare` | The *See the difference* box. |
| `loadIntoUi` / `onStorageChanged` / `handleHash` / `init` | Lifecycle and live sync. |

### `scripts/`

| File / function | Purpose |
|---|---|
| `make-extension-windows.ps1` | Windows builder (PowerShell 5.1 + .NET only): zip with `/` names, extract, marker, clipboard. |
| ↳ `Stop-WithError` / `Get-FullDir` / `New-ExtensionZip` | Error exit, normalized folder path, ZIP writer. |
| `make-icons.mjs` | Dependency-free PNG icon generator: `crc32`, `chunk`, `encodePng`, `inRoundedSquare`, `inArrow`, `render`. |

### `test/`

| File | Purpose |
|---|---|
| `unit/engine.test.js` | Matching semantics (default `anywhere`, modes side by side, Unicode, phrases, performance). |
| `unit/settings.test.js` | Sanitizing, sites, upsert/merge, portable format, the shipped example rules. |
| `unit/make-extension.test.js` | Both scripts on a temp project copy: ZIP + folder contents, re-run, refusals. Helpers: `listFiles`, `crc32`, `readZip`, `assertOutput`, `projectCopy`, `runUbuntu`, `win`, `toWin`, `runPs1`; `WINDOWS` detects PowerShell. |
| `e2e/content.test.js` | Page behaviour (text, attributes, untouched areas, dynamic, React, SSR, shadow DOM, iframes, editors, fights, streaming, options, detached content). |
| `e2e/ui.test.js` | Badge, context menus, options page (CRUD, import/export, merges, save on close, banner, compare box), popup, re-injection, restore on removal. |
| `e2e/rulesfile.test.js` | A hand-written `rules.json` map works; a broken one shows the red banner. |
| `e2e/harness.js` | `buildBundles`, `ssrPage`, `startServer`, `waitFor`, `launch({extDir})`, `getServiceWorker`, `getSettings`, `setSettings`, `tabIdFor`, `allText`. |
| `e2e/fixtures/*` | `static`, `dynamic`, `react` (+`react-app.jsx`), `shadow` (+`lit-app.js`), `frames` (+`child`), `editor`, `editable`, `fight`, `smoke`. |
| `smoke/vivaldi-smoke.js` | Real-Vivaldi check: `powershell`, `toWin`, `findVivaldi`, `smokePids`, `seedProfile`, `main`. |
