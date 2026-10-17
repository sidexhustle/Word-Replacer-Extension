/**
 * engine.js — Pure matching/replacement engine (no DOM, no chrome.* APIs).
 *
 * Purpose: turn a list of rules ({ from, to, match, enabled }) into ONE compiled,
 * Unicode-aware, case-insensitive regular expression and apply it to strings in a
 * single pass. It is shared by the content script, popup, options page, background
 * service worker and the Node unit tests (UMD-style export: `globalThis.WREngine`
 * in the browser, `module.exports` in Node).
 *
 * Matching semantics:
 *  - Case-insensitive; the replacement is inserted exactly as typed.
 *  - Modes: 'anywhere' (default; also inside other words: color → watercolor too),
 *           'wordStart' (word + endings: color, colors, colorful; not watercolor),
 *           'wholeWord' (exact word only: color; not colors).
 *  - Word characters are Unicode letters, combining marks and digits (\p{L}\p{M}\p{N}),
 *    so boundaries work for Vietnamese and other non-ASCII text (JS `\b` is ASCII-only).
 *  - Invisible characters inside words (soft hyphen, zero-width space/joiners, word joiner, BOM)
 *    are tolerated; any whitespace (incl. NBSP / line breaks) matches a space inside a phrase.
 *  - Rules are tried longest-first in a single pass, so replacements never chain (a→b, b→c ≠ a→c).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WREngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MATCH_MODES = Object.freeze(['anywhere', 'wordStart', 'wholeWord']);
  const DEFAULT_MATCH = 'anywhere';
  const MAX_FROM_LENGTH = 200;
  const MAX_TO_LENGTH = 500;

  const INVISIBLE = '[\\u00AD\\u200B-\\u200D\\u2060\\uFEFF]';
  const WORD_CHAR = '[\\p{L}\\p{M}\\p{N}]';
  const LEAD_BOUNDARY = `(?<!${WORD_CHAR}${INVISIBLE}*)`;
  const TRAIL_BOUNDARY = `(?!${INVISIBLE}*${WORD_CHAR})`;
  // One character class (\s already covers U+FEFF): an alternation of overlapping classes
  // would backtrack exponentially on long runs of U+FEFF.
  const PHRASE_SPACE = '[\\s\\u00AD\\u200B-\\u200D\\u2060]+';

  const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}]/u;
  const INVISIBLE_GLOBAL_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
  const WHITESPACE_RUN_RE = /\s+/gu;
  const COMBINING_MARK_RE = /\p{M}/u;
  const NON_ASCII_RE = /[^\u0000-\u007F]/;
  const REGEX_SYNTAX_RE = /[\\^$.*+?()[\]{}|/]/;

  /**
   * Normalizes the "find" text of a rule: NFC, invisible characters removed,
   * whitespace runs collapsed to one space, trimmed.
   * @param {unknown} from
   * @returns {string}
   */
  function normalizeFrom(from) {
    return String(from ?? '')
      .normalize('NFC')
      .replace(INVISIBLE_GLOBAL_RE, '')
      .replace(WHITESPACE_RUN_RE, ' ')
      .trim();
  }

  /**
   * Returns a key used to detect duplicate rules (same "find" text ignoring case).
   * @param {unknown} from
   * @returns {string}
   */
  function ruleKey(from) {
    return normalizeFrom(from).toLowerCase();
  }

  /**
   * Coerces any input into a well-formed rule object (does not validate).
   * @param {any} raw  rule-like object
   * @returns {{id: string, from: string, to: string, match: string, enabled: boolean}}
   */
  function normalizeRule(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof r.id === 'string' && r.id ? r.id : '',
      from: normalizeFrom(r.from),
      to: String(r.to ?? ''),
      match: MATCH_MODES.includes(r.match) ? r.match : DEFAULT_MATCH,
      enabled: r.enabled !== false,
    };
  }

  /**
   * Validates a (normalized) rule.
   * @param {{from: string, to: string, match: string}} rule
   * @returns {string|null} human-readable problem, or null when the rule is valid
   */
  function validateRule(rule) {
    if (!rule || typeof rule.from !== 'string' || rule.from.length === 0) return '"Find" is empty';
    if (rule.from.length > MAX_FROM_LENGTH) return `"Find" is longer than ${MAX_FROM_LENGTH} characters`;
    if (typeof rule.to !== 'string') return '"Replace with" must be text';
    if (rule.to.length > MAX_TO_LENGTH) return `"Replace with" is longer than ${MAX_TO_LENGTH} characters`;
    if (!MATCH_MODES.includes(rule.match)) return `Unknown match mode "${rule.match}"`;
    return null;
  }

  /**
   * Escapes one character for use inside a `u`-flag regular expression.
   * @param {string} ch single code point
   * @returns {string}
   */
  function escapeChar(ch) {
    return REGEX_SYNTAX_RE.test(ch) ? '\\' + ch : ch;
  }

  /**
   * Builds the regex source for one rule (without the surrounding capture group).
   * @param {string} from normalized find text (non-empty)
   * @param {string} match match mode
   * @returns {string}
   */
  function buildRulePattern(from, match) {
    const chars = Array.from(from);
    let body = '';
    let prevSpace = false;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ') {
        if (!prevSpace) body += PHRASE_SPACE;
        prevSpace = true;
        continue;
      }
      if (i > 0 && !prevSpace) body += `${INVISIBLE}*`;
      body += escapeChar(ch);
      prevSpace = false;
    }
    const lead = match !== 'anywhere' && WORD_CHAR_RE.test(chars[0]) ? LEAD_BOUNDARY : '';
    const trail = match === 'wholeWord' && WORD_CHAR_RE.test(chars[chars.length - 1]) ? TRAIL_BOUNDARY : '';
    return lead + body + trail;
  }

  /**
   * Compiles the enabled, valid rules into a single-pass matcher.
   * Duplicate "find" texts (ignoring case) keep the first rule.
   * @param {Array<object>} rules
   * @returns {null | {regex: RegExp, replacements: string[], rules: object[], minLength: number,
   *                   needsNFC: boolean, signature: string}} null when no rule is active
   */
  function compileRules(rules) {
    const seen = new Set();
    const active = [];
    (Array.isArray(rules) ? rules : []).forEach((raw, index) => {
      const rule = normalizeRule(raw);
      if (!rule.enabled || validateRule(rule)) return;
      const key = rule.from.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      active.push({ rule, index, len: Array.from(rule.from).length });
    });
    if (active.length === 0) return null;

    active.sort((a, b) => b.len - a.len || a.index - b.index);
    const ordered = active.map((a) => a.rule);
    const source = ordered.map((r) => `(${buildRulePattern(r.from, r.match)})`).join('|');
    return {
      regex: new RegExp(source, 'giu'),
      replacements: ordered.map((r) => r.to),
      rules: ordered,
      minLength: Math.min(...ordered.map((r) => r.from.length)),
      needsNFC: ordered.some((r) => NON_ASCII_RE.test(r.from)),
      signature: JSON.stringify(ordered.map((r) => [r.from, r.to, r.match])),
    };
  }

  /**
   * Applies compiled rules to a string in one pass.
   * @param {ReturnType<typeof compileRules>} compiled
   * @param {string} text
   * @returns {{text: string, count: number}} the new text and how many replacements were made
   *          (when count is 0 the original string is returned unchanged)
   */
  function replaceText(compiled, text) {
    if (!compiled || typeof text !== 'string' || text.length < compiled.minLength) return { text, count: 0 };
    let source = text;
    if (compiled.needsNFC && COMBINING_MARK_RE.test(text)) source = text.normalize('NFC');

    const re = compiled.regex;
    re.lastIndex = 0;
    let m = re.exec(source);
    if (m === null) return { text, count: 0 };

    const { replacements } = compiled;
    let out = '';
    let last = 0;
    let count = 0;
    do {
      let group = 1;
      while (group < m.length && m[group] === undefined) group++;
      out += source.slice(last, m.index) + replacements[group - 1];
      last = m.index + m[0].length;
      count++;
      if (m[0].length === 0) re.lastIndex++;
    } while ((m = re.exec(source)) !== null);
    re.lastIndex = 0;
    return { text: out + source.slice(last), count };
  }

  return Object.freeze({
    MATCH_MODES,
    DEFAULT_MATCH,
    MAX_FROM_LENGTH,
    MAX_TO_LENGTH,
    normalizeFrom,
    ruleKey,
    normalizeRule,
    validateRule,
    buildRulePattern,
    compileRules,
    replaceText,
  });
});
