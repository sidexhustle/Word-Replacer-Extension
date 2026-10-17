/**
 * content.js — DOM layer of Word Replacer. Runs in the extension's isolated world at
 * document_start in every frame (incl. about:blank / srcdoc / blob: frames).
 *
 * Purpose: replace configured words in everything the page shows, on any frontend stack,
 * WITHOUT breaking it:
 *  - Only Text.data and a few display attributes are changed IN PLACE; nodes are never
 *    wrapped, inserted or removed, so React/Vue/Angular/Svelte/Lit keep their references
 *    and simply get re-processed when they update a node.
 *  - One MutationObserver (document + every shadow root, open or closed) handles dynamic
 *    content before it is painted; our own writes come back as records but are skipped
 *    cheaply (WeakMap check), so there is no feedback loop.
 *  - Original values live in WeakMaps → disabling or editing rules restores/re-applies live.
 *  - Inputs, text areas, rich-text editors (contenteditable, designMode), scripts, styles,
 *    templates and media fallbacks are never touched, so nothing you type or save changes.
 */
(() => {
  'use strict';

  const Engine = globalThis.WREngine;
  const Settings = globalThis.WRSettings;
  if (!Engine || !Settings || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  // ---------------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------------
  const INSTANCE_EVENT = 'wr:content-instance-v1';
  const SHADOW_EVENT = 'wr:shadow-attached-v1'; // must match shadow-hook.js
  const SHADOW_DETACHED_EVENT = 'wr:shadow-attached-detached-v1'; // must match shadow-hook.js
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const DOCUMENT_NODE = 9;
  const FRAGMENT_NODE = 11;
  const SHOW_ELEMENT = 0x1;
  const SHOW_TEXT = 0x4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;
  const FILTER_SKIP = 3;

  /** Elements whose content is never visible text or must never be modified. */
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'textarea', 'iframe', 'frame', 'frameset',
    'object', 'embed', 'canvas', 'video', 'audio', 'xmp', 'plaintext',
  ]);
  const EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false" i])';
  /** Built-in elements allowed to host a shadow root (custom elements are checked separately). */
  const BUILTIN_HOST_SELECTOR =
    'article,aside,blockquote,body,div,footer,h1,h2,h3,h4,h5,h6,header,main,nav,p,section,span';
  const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset']);
  /** Display attributes that may be replaced (each gated by a "surface" setting). */
  const DISPLAY_ATTRIBUTES = ['title', 'placeholder', 'alt', 'value', 'label'];
  const OBSERVE_OPTIONS = {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true, // detects text appended to nodes we rewrote (streaming HTML)
    attributes: true,
    attributeFilter: [...DISPLAY_ATTRIBUTES, 'contenteditable'],
  };
  const NO_MATCH = Object.freeze({ text: '', count: 0 });
  const FIGHT_WINDOW_MS = 1000;
  const FIGHT_MAX_WRITES = 100;
  const COUNT_DELAY_MS = 1500;
  const CONTEXT_CHECK_MS = 5000;

  const isTop = window === window.top;
  const domApi = chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function' ? chrome.dom : null;

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  let compiled = null; // Engine.compileRules() result while active
  let surfaces = Settings.defaultSettings().surfaces;
  let active = false;
  let dead = false;
  let deepScanStarted = false;
  let configSignature = '';
  let stateLabel = 'on'; // 'on' | 'off' (globally) | 'site-off'
  let excludedSelector = '';

  const originals = new WeakMap(); // Text -> { original, replaced, count, gen }
  const attrOriginals = new WeakMap(); // Element -> Map(attrName -> { original, replaced, count, gen })
  const lockedOptions = new WeakMap(); // <option> -> value attribute we pinned
  let fightCounters = new WeakMap(); // parent node -> { start, writes }
  let contested = new WeakSet(); // parents we stopped rewriting (a script keeps resetting them)
  // Records are NOT cleared on settings changes: nodes detached at that moment (cached SPA views)
  // keep their record, and a record from an older generation is restored when re-inserted.
  let generation = 0;
  let everReplaced = false; // once true, the observer stays on while paused (to restore re-inserted nodes)
  const cleanedHosts = new WeakSet(); // editing hosts whose subtree was already restored

  const rootSet = new WeakSet(); // shadow roots we listen on
  const rootRefs = new Set(); // WeakRef<ShadowRoot> so roots can be iterated without leaking
  const knownHosts = new WeakSet(); // hosts reported by shadow-hook.js
  const handledEvents = new WeakSet();
  const observer = new MutationObserver(onMutations);

  let countTimer = 0;
  let lastReportedCount = -1;
  let lastReportedState = '';
  let contextTimer = 0;

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  /** True while the extension that injected this script is still loaded (not reloaded/removed). */
  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /** Hostname of the top-level page (iframes inherit the top site's "disable on this site"). */
  function topSiteHostname() {
    if (isTop) return location.hostname;
    const ancestors = location.ancestorOrigins;
    if (ancestors && ancestors.length) {
      try {
        return new URL(ancestors[ancestors.length - 1]).hostname;
      } catch (_) { /* opaque origin */ }
    }
    try {
      return window.top.location.hostname;
    } catch (_) {
      return location.hostname;
    }
  }

  /** CSS selector matching ancestors whose descendants must not be modified. */
  function buildExcludedSelector(s) {
    const parts = [...SKIP_TAGS, EDITABLE_SELECTOR];
    if (!s.title) parts.push('title');
    if (!s.tooltips) parts.push('svg title');
    return parts.join(',');
  }

  /** `closest()` that also climbs out of shadow roots through their hosts. */
  function closestAcrossShadow(node, selector) {
    let el = node && node.nodeType === ELEMENT_NODE ? node : node && node.parentElement;
    while (el) {
      const hit = el.closest(selector);
      if (hit) return hit;
      const root = el.getRootNode();
      el = root && root.nodeType === FRAGMENT_NODE ? root.host : null;
    }
    return null;
  }

  /** True when children of `parent` may be rewritten (not inside excluded/editable content). */
  function allowedContext(parent) {
    if (!parent) return false;
    if (parent.nodeType === DOCUMENT_NODE) return true;
    if (parent.nodeType === FRAGMENT_NODE) return parent.host ? !closestAcrossShadow(parent.host, excludedSelector) : false;
    if (parent.nodeType !== ELEMENT_NODE) return false;
    return !closestAcrossShadow(parent, excludedSelector);
  }

  /** True for an element that starts an editable region (contenteditable other than "false"). */
  function isEditableRoot(el) {
    const ce = el.getAttribute('contenteditable');
    return ce !== null && ce.toLowerCase() !== 'false';
  }

  /** True when an element's subtree must be skipped while walking. */
  function isSkippedElement(el) {
    const name = el.localName;
    if (SKIP_TAGS.has(name)) return true;
    if (name === 'title') return el.namespaceURI === SVG_NS ? !surfaces.tooltips : !surfaces.title;
    return false;
  }

  /** Returns the open or closed shadow root of an element, if any. */
  function getShadowRoot(el) {
    const open = el.shadowRoot;
    if (open) return open;
    if (!domApi || !(el instanceof HTMLElement)) return null;
    // Closed roots: custom elements, or hosts reported by the attachShadow hook (keeps walks fast).
    if (!el.localName.includes('-') && !knownHosts.has(el)) return null;
    try {
      return domApi.openOrClosedShadowRoot(el) || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Rate-limits rewrites per parent node: if a page script keeps resetting a node we rewrote
   * (> FIGHT_MAX_WRITES per second), stop touching it instead of ping-ponging forever.
   */
  function isContested(parent) {
    if (contested.has(parent)) return true;
    const now = performance.now();
    let c = fightCounters.get(parent);
    if (!c || now - c.start > FIGHT_WINDOW_MS) {
      c = { start: now, writes: 0 };
      fightCounters.set(parent, c);
    }
    if (++c.writes > FIGHT_MAX_WRITES) {
      contested.add(parent);
      console.debug('[Word Replacer] stopped rewriting a node that a page script keeps resetting:', parent);
      return true;
    }
    return false;
  }

  /** Whether attribute `name` of `el` is a replaceable display attribute under current settings. */
  function attributeAllowed(el, name) {
    switch (name) {
      case 'title':
        return surfaces.tooltips;
      case 'placeholder':
        return surfaces.placeholders;
      case 'alt':
        return surfaces.altText;
      case 'value': {
        if (!surfaces.buttonLabels || el.localName !== 'input') return false;
        const type = (el.getAttribute('type') || '').toLowerCase();
        // A NAMED submit button sends name=value with the form, so its value is data: keep it.
        if (type === 'submit') return !el.getAttribute('name');
        return BUTTON_INPUT_TYPES.has(type);
      }
      case 'label':
        return el.localName === 'option' || el.localName === 'optgroup';
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Rewriting
  // ---------------------------------------------------------------------------------------------

  /**
   * The text an <option> would submit without our replacements (option.text semantics:
   * ASCII whitespace stripped and collapsed), and whether any of its text is replaced.
   */
  function optionOriginalText(option) {
    let text = '';
    let replaced = false;
    const walker = document.createTreeWalker(option, SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const rec = originals.get(n);
      if (rec !== undefined && rec.replaced === n.data) {
        text += rec.original;
        replaced = true;
      } else {
        text += n.data;
      }
    }
    return { value: text.replace(/[\t\n\f\r ]+/g, ' ').trim(), replaced };
  }

  /**
   * Keeps a <option>'s submitted value equal to its ORIGINAL text: an option without a value
   * attribute submits its text, so while its text is replaced we pin `value` to the original text,
   * follow later text changes made by the page, and remove the pin when nothing is replaced.
   * Options with their own value attribute are left alone.
   */
  function syncOption(option) {
    const pinned = lockedOptions.get(option);
    const attr = option.getAttribute('value');
    if (attr !== null && attr !== pinned) {
      lockedOptions.delete(option); // the page's own value
      return;
    }
    const { value, replaced } = optionOriginalText(option);
    if (replaced) {
      if (attr !== value) option.setAttribute('value', value);
      lockedOptions.set(option, value);
    } else if (pinned !== undefined) {
      if (attr !== null) option.removeAttribute('value');
      lockedOptions.delete(option);
    }
  }

  /**
   * When the page or the HTML parser appended/prepended to text we had rewritten (streaming
   * HTML, appendData, typewriter effects), returns the rebuilt original text so replacements
   * don't compound and word boundaries are re-checked on the full text. Otherwise undefined.
   */
  function extendedBase(node, oldValue) {
    const rec = originals.get(node);
    if (rec === undefined || oldValue !== rec.replaced) return undefined;
    const data = node.data;
    if (data === rec.replaced) return undefined;
    if (data.startsWith(rec.replaced)) return rec.original + data.slice(rec.replaced.length);
    if (data.endsWith(rec.replaced)) return data.slice(0, data.length - rec.replaced.length) + rec.original;
    return undefined;
  }

  /**
   * Replaces matches inside one text node (in place), or restores it when paused.
   * @param {Text} node
   * @param {boolean} viaMutation true when triggered by a page mutation (fight guard applies)
   * @param {string} [base] original text to start from (see extendedBase)
   */
  function processText(node, viaMutation, base) {
    const data = node.data;
    const rec = originals.get(node);
    if (base === undefined) {
      if (rec !== undefined && rec.replaced === data) {
        if (active && rec.gen === generation) return; // already ours, current rules
        base = rec.original; // replaced under older settings (node was detached meanwhile)
      } else {
        if (rec !== undefined) originals.delete(node); // the page wrote new text
        if (!active || data.length < compiled.minLength) return;
        base = data;
      }
    }
    const res = active ? Engine.replaceText(compiled, base) : NO_MATCH;
    const parent = node.parentNode;
    if (res.count === 0) {
      originals.delete(node);
      if (base !== data) {
        node.data = base; // put the original text back
        if (parent && parent.localName === 'option') syncOption(parent);
      }
      return;
    }
    if (viaMutation && parent && isContested(parent)) return;
    originals.set(node, { original: base, replaced: res.text, count: res.count, gen: generation });
    everReplaced = true;
    if (res.text !== data) node.data = res.text;
    if (parent && parent.localName === 'option') syncOption(parent);
  }

  /** Replaces matches inside one display attribute (in place), or restores it when not allowed. */
  function processAttr(el, name, viaMutation) {
    const value = el.getAttribute(name);
    const map = attrOriginals.get(el);
    const rec = map && map.get(name);
    const allowed = active && attributeAllowed(el, name);
    let base;
    if (rec && rec.replaced === value) {
      if (allowed && rec.gen === generation) return;
      base = rec.original;
    } else {
      if (rec) map.delete(name);
      if (!allowed || value === null || value.length < compiled.minLength) return;
      base = value;
    }
    const res = allowed ? Engine.replaceText(compiled, base) : NO_MATCH;
    if (res.count === 0) {
      if (map) map.delete(name);
      if (base !== value) el.setAttribute(name, base);
      return;
    }
    if (viaMutation && isContested(el)) return;
    let m = map;
    if (!m) {
      m = new Map();
      attrOriginals.set(el, m);
    }
    m.set(name, { original: base, replaced: res.text, count: res.count, gen: generation });
    everReplaced = true;
    if (res.text !== value) el.setAttribute(name, res.text);
  }

  /** Processes all display attributes of an element (replace, or restore stale ones). */
  function processAttributes(el) {
    const map = attrOriginals.get(el);
    if (!map && (!active || !el.hasAttributes())) return;
    for (const name of DISPLAY_ATTRIBUTES) {
      if ((map && map.has(name)) || (active && el.hasAttribute(name) && attributeAllowed(el, name))) {
        processAttr(el, name, false);
      }
    }
  }

  /**
   * Processes a subtree (Document, ShadowRoot or Element): text nodes, display attributes and
   * nested shadow roots. Excluded/editable subtrees are skipped entirely.
   */
  function processTree(root) {
    if (root.nodeType === ELEMENT_NODE) {
      if (isEditableRoot(root)) return;
      processAttributes(root);
      if (isSkippedElement(root)) return;
      const sr = getShadowRoot(root);
      if (sr) adoptRoot(sr);
    }
    const hosts = [];
    const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === TEXT_NODE) return FILTER_ACCEPT;
        if (isEditableRoot(node)) return FILTER_REJECT;
        processAttributes(node);
        if (isSkippedElement(node)) return FILTER_REJECT;
        if (node.shadowRoot || node.localName.includes('-') || knownHosts.has(node)) hosts.push(node);
        return FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) processText(node, false);
    for (const host of hosts) {
      const sr = getShadowRoot(host);
      if (sr) adoptRoot(sr);
    }
  }

  /** Starts observing a shadow root (once) and processes its content. */
  function adoptRoot(sr) {
    if (!rootSet.has(sr)) {
      rootSet.add(sr);
      rootRefs.add(new WeakRef(sr));
      sr.addEventListener(SHADOW_EVENT, onShadowEvent);
    }
    observer.observe(sr, OBSERVE_OPTIONS);
    processTree(sr);
  }

  /** Finds shadow roots not adopted yet (e.g. declarative shadow DOM attached during parsing). */
  function discoverRoots(root) {
    const walker = document.createTreeWalker(root, SHOW_ELEMENT, {
      acceptNode(el) {
        return isEditableRoot(el) || isSkippedElement(el) ? FILTER_REJECT : FILTER_ACCEPT;
      },
    });
    let el;
    while ((el = walker.nextNode())) {
      const sr = getShadowRoot(el);
      if (!sr) continue;
      if (rootSet.has(sr)) discoverRoots(sr);
      else adoptRoot(sr);
    }
  }

  /**
   * One-time, idle-time scan for CLOSED declarative shadow roots on built-in elements
   * (<div><template shadowrootmode="closed">). The parser creates those without calling
   * attachShadow, and checking every element on every walk would be too slow, so after the page
   * has loaded we check the elements that can host a shadow root in small idle slices.
   */
  function scheduleDeepScan() {
    if (!domApi || deepScanStarted || !active) return;
    deepScanStarted = true;
    const queue = [];
    forEachRoot((r) => queue.push(r), true);
    let list = null;
    let index = 0;
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
    const step = () => {
      if (!active || dead) return;
      const until = performance.now() + 8;
      while (performance.now() < until) {
        if (!list || index >= list.length) {
          const root = queue.shift();
          if (!root) return;
          list = root.querySelectorAll(BUILTIN_HOST_SELECTOR);
          index = 0;
          continue;
        }
        const el = list[index++];
        if (el.shadowRoot || !el.isConnected) continue;
        let sr = null;
        try {
          sr = domApi.openOrClosedShadowRoot(el);
        } catch (_) {
          /* not a valid host */
        }
        if (sr && !rootSet.has(sr) && allowedContext(el)) {
          knownHosts.add(el);
          adoptRoot(sr);
          queue.push(sr);
          scheduleCount();
        }
      }
      idle(step, { timeout: 1000 });
    };
    idle(step, { timeout: 1000 });
  }

  /** Calls fn for the document and every live shadow root we know about. */
  function forEachRoot(fn, connectedOnly) {
    fn(document);
    for (const ref of rootRefs) {
      const r = ref.deref();
      if (!r) {
        rootRefs.delete(ref);
        continue;
      }
      if (connectedOnly && !r.host.isConnected) continue;
      fn(r);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Restore & count
  // ---------------------------------------------------------------------------------------------

  /** Restores one node's original text / attributes / option value and forgets its records. */
  function restoreNode(n) {
    if (n.nodeType === TEXT_NODE) {
      const rec = originals.get(n);
      if (rec !== undefined) {
        if (rec.replaced === n.data) n.data = rec.original;
        originals.delete(n);
      }
      return;
    }
    if (n.nodeType !== ELEMENT_NODE) return;
    const map = attrOriginals.get(n);
    if (map) {
      for (const [name, rec] of map) if (n.getAttribute(name) === rec.replaced) n.setAttribute(name, rec.original);
      attrOriginals.delete(n);
    }
    const pinned = lockedOptions.get(n);
    if (pinned !== undefined) {
      if (n.getAttribute('value') === pinned) n.removeAttribute('value');
      lockedOptions.delete(n);
    }
  }

  /** Restores everything inside one root (document, shadow root or element), not nested roots. */
  function restoreIn(root) {
    if (root.nodeType === ELEMENT_NODE) restoreNode(root);
    const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) restoreNode(n);
  }

  /** Restores a subtree including the shadow roots inside it (used for editing hosts). */
  function restoreSubtree(root) {
    cleanedHosts.add(root);
    restoreIn(root);
    const walker = document.createTreeWalker(root, SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      const sr = el.shadowRoot || (el.localName.includes('-') || knownHosts.has(el) ? getShadowRoot(el) : null);
      if (sr && rootSet.has(sr)) restoreSubtree(sr);
    }
  }

  /**
   * Puts every original text/attribute back in the document and all known shadow roots (only where
   * the page has not changed it since). Records of nodes that are detached right now are kept, so
   * those nodes are restored (or re-processed) if the page inserts them again.
   */
  function restoreAll() {
    forEachRoot(restoreIn, false);
    fightCounters = new WeakMap();
    contested = new WeakSet();
  }

  /** Counts replacements currently visible in this frame (text + attributes). */
  function countAll() {
    let total = 0;
    forEachRoot((root) => {
      const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeType === TEXT_NODE) {
          const rec = originals.get(n);
          if (rec !== undefined && rec.gen === generation && rec.replaced === n.data) total += rec.count;
        } else {
          const map = attrOriginals.get(n);
          if (map) {
            for (const [name, rec] of map) {
              if (rec.gen === generation && n.getAttribute(name) === rec.replaced) total += rec.count;
            }
          }
        }
      }
    }, true);
    return total;
  }

  /** Sends this frame's count/state to the background worker (badge + popup). */
  function reportCount(force) {
    if (dead || !contextAlive()) return;
    const count = active ? countAll() : 0;
    // Sub-frames only matter for the badge once they have (or had) replacements.
    if (!isTop && count === 0 && lastReportedCount <= 0) return;
    if (!force && count === lastReportedCount && stateLabel === lastReportedState) return;
    lastReportedCount = count;
    lastReportedState = stateLabel;
    send({ type: 'wr:count', count, state: stateLabel });
  }

  /** Throttled (trailing) count report after DOM changes. */
  function scheduleCount() {
    if (countTimer || dead) return;
    countTimer = setTimeout(() => {
      countTimer = 0;
      reportCount(false);
    }, COUNT_DELAY_MS);
  }

  /** Fire-and-forget message to the background worker. */
  function send(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* extension reloaded */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Mutation handling
  // ---------------------------------------------------------------------------------------------

  /**
   * MutationObserver callback: rewrites added/changed content before it is painted. While paused
   * (after replacements were made), it only restores re-inserted nodes that still show an old
   * replacement.
   */
  function onMutations(records) {
    if (dead) return;
    if (!contextAlive()) {
      teardown();
      return;
    }
    if (active && document.designMode === 'on') {
      restoreForDesignMode();
      return;
    }
    const options = new Set();
    for (const r of records) {
      const t = r.target;
      if (r.type === 'childList') {
        if (t.localName === 'option') options.add(t);
        const added = r.addedNodes;
        if (added.length === 0 || !allowedContext(t)) continue;
        for (let i = 0; i < added.length; i++) {
          const n = added[i];
          if (!n.isConnected) continue;
          if (n.nodeType === TEXT_NODE) processText(n, true);
          else if (n.nodeType === ELEMENT_NODE) processTree(n);
        }
      } else if (r.type === 'characterData') {
        if (t.nodeType !== TEXT_NODE || !t.isConnected) continue;
        const parent = t.parentNode;
        if (parent && parent.localName === 'option') options.add(parent);
        if (allowedContext(parent)) processText(t, true, extendedBase(t, r.oldValue));
      } else if (r.type === 'attributes') {
        if (r.attributeName === 'contenteditable') onEditableChanged(t);
        else if (!closestAcrossShadow(t, EDITABLE_SELECTOR)) processAttr(t, r.attributeName, true);
      }
    }
    for (const option of options) if (option.isConnected) syncOption(option);
    if (active) scheduleCount();
  }

  /** An element became editable (restore its subtree) or stopped being editable (process it). */
  function onEditableChanged(el) {
    if (isEditableRoot(el)) {
      restoreSubtree(el);
    } else {
      cleanedHosts.delete(el);
      if (active && allowedContext(el.parentNode || el.getRootNode())) processTree(el);
    }
  }

  /**
   * Before the user edits (focusin / beforeinput, capture phase): make sure the editing host only
   * contains original text, so an editor can never save a replacement into your content.
   */
  function onEditIntent(e) {
    if (!everReplaced || dead) return;
    if (document.designMode === 'on') {
      if (active) restoreForDesignMode();
      return;
    }
    const target = e.composedPath()[0] || e.target;
    const el = target && (target.nodeType === ELEMENT_NODE ? target : target.parentElement);
    if (!el) return;
    const host = closestAcrossShadow(el, EDITABLE_SELECTOR);
    if (host && !cleanedHosts.has(host)) restoreSubtree(host);
  }

  /** The whole document became an editor (designMode): restore everything and stay out of it. */
  function restoreForDesignMode() {
    observer.disconnect();
    restoreAll();
    active = false;
    configSignature = 'design-mode';
    reportCount(true);
  }

  /** shadow-hook.js reported a new shadow root on a connected host: observe and process it. */
  function onShadowEvent(e) {
    if (handledEvents.has(e)) return;
    handledEvents.add(e);
    const host = e.target;
    if (!host || host.nodeType !== ELEMENT_NODE) return;
    knownHosts.add(host); // remembered even before settings load, so the first full pass finds it
    if (!active) return;
    if (!allowedContext(host.parentNode || host.getRootNode())) return;
    const sr = getShadowRoot(host);
    if (!sr) return;
    if (rootSet.has(sr)) discoverRoots(sr);
    else adoptRoot(sr);
    scheduleCount();
  }

  /** shadow-hook.js reported a shadow root on a host not in the document yet: remember the host. */
  function onDetachedShadowEvent(e) {
    const host = e.relatedTarget;
    if (host && host.nodeType === ELEMENT_NODE) knownHosts.add(host);
  }

  /** Late rescan for shadow roots attached during parsing (declarative shadow DOM). */
  function onLoadRescan(e) {
    if (!active || dead) return;
    discoverRoots(document);
    if (e && e.type === 'load') scheduleDeepScan();
    reportCount(true);
  }

  /** Back/forward-cache restore: the badge was reset by the navigation, report again. */
  function onPageShow(e) {
    if (!e.persisted || dead) return;
    if (isTop) send({ type: 'wr:hello' });
    reportCount(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  /** Applies (new) settings: restores previous replacements, then re-applies with the new config. */
  function applySettings(settings) {
    if (dead) return;
    const siteOff = Settings.isSiteDisabled(settings, topSiteHostname());
    stateLabel = !settings.enabled ? 'off' : siteOff ? 'site-off' : 'on';
    const next = stateLabel === 'on' ? Engine.compileRules(settings.rules) : null;
    const signature = next ? `${next.signature}|${JSON.stringify(settings.surfaces)}` : 'inactive';
    if (signature === configSignature) {
      reportCount(true);
      return;
    }
    configSignature = signature;
    generation++;

    observer.disconnect();
    restoreAll();
    compiled = next;
    surfaces = { ...settings.surfaces };
    excludedSelector = buildExcludedSelector(surfaces);
    active = Boolean(compiled) && document.designMode !== 'on';
    if (active) {
      observer.observe(document, OBSERVE_OPTIONS);
      processTree(document);
      // Injected into an already-loaded page (install/update): no "load" event will come.
      if (document.readyState === 'complete') scheduleDeepScan();
    } else if (everReplaced && document.designMode !== 'on') {
      // Paused after replacements were made: keep watching (cheaply) so content that was detached
      // while we restored (cached SPA views) gets its original text back when re-inserted.
      forEachRoot((root) => observer.observe(root, OBSERVE_OPTIONS), true);
    }
    reportCount(true);
  }

  /** Reacts to settings saved by the popup/options page/background (live update, no reload). */
  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes[Settings.STORAGE_KEY]) return;
    if (!contextAlive()) {
      teardown();
      return;
    }
    applySettings(Settings.sanitizeSettings(changes[Settings.STORAGE_KEY].newValue));
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /** Stops this instance and restores the page (extension reloaded/disabled, or newer instance). */
  function teardown() {
    if (dead) return;
    dead = true;
    active = false;
    try {
      observer.disconnect();
      restoreAll();
    } catch (_) {
      /* best effort */
    }
    clearTimeout(countTimer);
    clearInterval(contextTimer);
    document.removeEventListener(INSTANCE_EVENT, teardown);
    document.removeEventListener(SHADOW_EVENT, onShadowEvent);
    document.removeEventListener(SHADOW_DETACHED_EVENT, onDetachedShadowEvent, true);
    document.removeEventListener('focusin', onEditIntent, true);
    document.removeEventListener('beforeinput', onEditIntent, true);
    document.removeEventListener('DOMContentLoaded', onLoadRescan);
    window.removeEventListener('load', onLoadRescan);
    window.removeEventListener('pageshow', onPageShow);
    forEachRoot((r) => r !== document && r.removeEventListener(SHADOW_EVENT, onShadowEvent), false);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (_) {
      /* context gone */
    }
  }

  /** Entry point. */
  function init() {
    // Ask an older instance in this frame (e.g. from before an extension reload) to restore & stop.
    document.dispatchEvent(new CustomEvent(INSTANCE_EVENT));
    document.addEventListener(INSTANCE_EVENT, teardown);
    document.addEventListener(SHADOW_EVENT, onShadowEvent);
    document.addEventListener(SHADOW_DETACHED_EVENT, onDetachedShadowEvent, true);
    document.addEventListener('focusin', onEditIntent, true);
    document.addEventListener('beforeinput', onEditIntent, true);
    document.addEventListener('DOMContentLoaded', onLoadRescan, { once: true });
    window.addEventListener('load', onLoadRescan, { once: true });
    window.addEventListener('pageshow', onPageShow);
    chrome.storage.onChanged.addListener(onStorageChanged);
    contextTimer = setInterval(() => {
      if (!contextAlive()) teardown();
    }, CONTEXT_CHECK_MS);
    if (isTop) send({ type: 'wr:hello' });
    Settings.loadSettings().then(applySettings, (err) => console.debug('[Word Replacer] settings load failed', err));
  }

  init();
})();
