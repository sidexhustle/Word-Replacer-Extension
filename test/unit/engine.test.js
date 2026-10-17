/**
 * engine.test.js — Unit tests for extension/src/shared/engine.js (node:test, no dependencies).
 *
 * Purpose: lock down the matching semantics (modes with "anywhere" as default, case, Unicode /
 * Vietnamese, invisible characters, phrases, longest-first, single pass, special characters,
 * counts, validation, performance).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../extension/src/shared/engine.js');

/** Compiles rules and returns a function text -> replaced text. */
function replacer(rules) {
  const compiled = E.compileRules(rules);
  return (text) => E.replaceText(compiled, text).text;
}

test('basics: case-insensitive, output exactly as typed', () => {
  const r = replacer([
    { from: 'apple', to: 'A1' },
    { from: 'banana', to: 'B2' },
  ]);
  assert.equal(r('Apple at 9, APPLE later, apple now'), 'A1 at 9, A1 later, A1 now');
  assert.equal(r('Banana app and BANANA'), 'B2 app and B2');
});

test('anywhere is the default: also inside other words', () => {
  assert.equal(E.DEFAULT_MATCH, 'anywhere');
  assert.equal(E.normalizeRule({ from: 'x', to: 'y' }).match, 'anywhere');
  const r = replacer([{ from: 'color', to: 'colour' }]);
  assert.equal(r('color colors watercolor Colorado discolored'), 'colour colours watercolour colourado discoloured');
});

test('wordStart: word + endings, not inside other words', () => {
  const r = replacer([{ from: 'color', to: 'colour', match: 'wordStart' }]);
  assert.equal(r('colors colorful coloring'), 'colours colourful colouring');
  assert.equal(r('watercolor discolor'), 'watercolor discolor');
  assert.equal(r('multi-color #color (color) "color"'), 'multi-colour #colour (colour) "colour"');
  assert.equal(r('my_color color2024'), 'my_colour colour2024');
});

test('wholeWord: exact word only', () => {
  const r = replacer([{ from: 'color', to: 'colour', match: 'wholeWord' }]);
  assert.equal(r('color, colors, color.'), 'colour, colors, colour.');
  assert.equal(r("color's"), "colour's");
});

test('the three modes side by side (the options-page example)', () => {
  const text = 'color, Colors, watercolor, Colorado';
  const run = (match) => replacer([{ from: 'color', to: 'colour', match }])(text);
  assert.equal(run('anywhere'), 'colour, colours, watercolour, colourado');
  assert.equal(run('wordStart'), 'colour, colours, watercolor, colourado');
  assert.equal(run('wholeWord'), 'colour, Colors, watercolor, Colorado');
});

test('per-rule modes can be mixed', () => {
  const r = replacer([
    { from: 'cat', to: 'C', match: 'wholeWord' },
    { from: 'dog', to: 'D', match: 'anywhere' },
  ]);
  assert.equal(r('cat cats hotdog'), 'C cats hotD');
});

test('longest rule wins when rules overlap', () => {
  const r = replacer([
    { from: 'book', to: 'B' },
    { from: 'bookstore', to: 'BS' },
    { from: 'old book', to: 'OB' },
  ]);
  assert.equal(r('bookstore book old book'), 'BS B OB');
});

test('single pass: replacements never chain', () => {
  const r = replacer([
    { from: 'a', to: 'b', match: 'wholeWord' },
    { from: 'b', to: 'c', match: 'wholeWord' },
  ]);
  assert.equal(r('a b'), 'b c');
});

test('replacement containing the search word is not re-expanded', () => {
  const r = replacer([{ from: 'cat', to: 'cats' }]);
  assert.equal(r('cat'), 'cats');
});

test('Vietnamese: Unicode-aware boundaries, case-insensitive, NFC and NFD text', () => {
  const r = replacer([{ from: 'cà phê', to: 'cf' }]);
  assert.equal(r('Uống Cà phê mỗi sáng'), 'Uống cf mỗi sáng');
  assert.equal(r('CÀ PHÊ'), 'cf');
  assert.equal(r('Uống cà phê'.normalize('NFD')), 'Uống cf');
  const w = replacer([{ from: 'sữa', to: 'X', match: 'wholeWord' }]);
  assert.equal(w('trà sữa, sữatươi'), 'trà X, sữatươi');
});

test('NFD rule text is normalized too', () => {
  const r = replacer([{ from: 'café'.normalize('NFD'), to: 'C' }]);
  assert.equal(r('Café au lait'), 'C au lait');
});

test('invisible characters inside words are tolerated', () => {
  const r = replacer([{ from: 'apple', to: 'A1', match: 'wordStart' }]);
  assert.equal(r('app\u00ADle'), 'A1');
  assert.equal(r('app\u200Ble'), 'A1');
  assert.equal(r('pine\u00ADapple'), 'pine\u00ADapple', 'a soft hyphen inside a word is not a word start');
});

test('phrases match any whitespace (NBSP, newlines, multiple spaces)', () => {
  const r = replacer([{ from: 'ice   cream', to: 'IC' }]);
  assert.equal(r('ice cream'), 'IC');
  assert.equal(r('ice\u00A0cream'), 'IC');
  assert.equal(r('Ice\n  Cream'), 'IC');
  assert.equal(r('icecream'), 'icecream');
});

test('regex special characters are literal; boundaries only where the rule has letters', () => {
  const r = replacer([
    { from: 'C++', to: 'cpp', match: 'wholeWord' },
    { from: '.NET', to: 'dotnet', match: 'wholeWord' },
    { from: '(a|b)', to: 'X', match: 'anywhere' },
    { from: 'node.js', to: 'NJS', match: 'wholeWord' },
  ]);
  assert.equal(r('C++ and .NET and (a|b)'), 'cpp and dotnet and X');
  assert.equal(r('nodexjs node.js'), 'nodexjs NJS');
});

test('counts replacements and returns the same string when nothing matches', () => {
  const c = E.compileRules([{ from: 'banana', to: 'B2' }]);
  const text = 'nothing here';
  const res = E.replaceText(c, text);
  assert.equal(res.count, 0);
  assert.equal(res.text, text);
  assert.deepEqual(E.replaceText(c, 'banana BANANA banana'), { text: 'B2 B2 B2', count: 3 });
});

test('text shorter than the shortest rule is skipped quickly', () => {
  const c = E.compileRules([{ from: 'pineapple', to: 'P' }]);
  assert.equal(c.minLength, 9);
  assert.deepEqual(E.replaceText(c, 'short'), { text: 'short', count: 0 });
});

test('empty replacement removes the word', () => {
  const r = replacer([{ from: 'secret', to: '' }]);
  assert.equal(r('a secret plan'), 'a  plan');
});

test('disabled, invalid and duplicate rules are ignored (first duplicate wins)', () => {
  const c = E.compileRules([
    { from: '', to: 'x' },
    { from: '   ', to: 'x' },
    { from: 'off', to: 'X', enabled: false },
    { from: 'dup', to: 'first' },
    { from: 'DUP', to: 'second' },
    { from: 'x'.repeat(E.MAX_FROM_LENGTH + 1), to: 'y' },
  ]);
  assert.equal(c.rules.length, 1);
  assert.equal(E.replaceText(c, 'dup off').text, 'first off');
  assert.equal(E.compileRules([]), null);
  assert.equal(E.compileRules([{ from: 'a', to: 'b', enabled: false }]), null);
});

test('normalizeRule fills defaults and validateRule reports problems', () => {
  assert.deepEqual(E.normalizeRule({ from: '  ice \n cream ', to: 3 }), {
    id: '',
    from: 'ice cream',
    to: '3',
    match: 'anywhere',
    enabled: true,
  });
  assert.equal(E.validateRule(E.normalizeRule({ from: 'ok', to: 'fine' })), null);
  assert.match(E.validateRule(E.normalizeRule({ from: '' })), /empty/);
  assert.match(E.validateRule({ from: 'a', to: 'b', match: 'weird' }), /match mode/);
});

test('signature changes when rules change (used to skip no-op re-applies)', () => {
  const a = E.compileRules([{ from: 'apple', to: 'A1' }]);
  const b = E.compileRules([{ from: 'apple', to: 'A2' }]);
  const c = E.compileRules([{ from: 'apple', to: 'A1' }]);
  assert.notEqual(a.signature, b.signature);
  assert.equal(a.signature, c.signature);
});

test('regex state is reset between calls (global regex lastIndex)', () => {
  const c = E.compileRules([{ from: 'apple', to: 'A1' }]);
  for (let i = 0; i < 3; i++) assert.equal(E.replaceText(c, 'an apple').text, 'an A1');
});

test('no catastrophic backtracking on long runs of invisible/space characters', () => {
  const c = E.compileRules([{ from: 'ice cream', to: 'IC' }]);
  for (const ch of ['\uFEFF', '\u00A0', '\u200B', ' ']) {
    const text = `ice${ch.repeat(5000)}x`;
    const t0 = process.hrtime.bigint();
    E.replaceText(c, text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `U+${ch.codePointAt(0).toString(16)} run took ${ms.toFixed(0)} ms`);
  }
  assert.equal(E.replaceText(c, 'ice\uFEFF\uFEFFcream').text, 'IC');
});

test('performance: 300 rules over 1 MB of text stays fast', () => {
  const rules = Array.from({ length: 300 }, (_, i) => ({ from: `word${i}x`, to: `w${i}` }));
  rules.push({ from: 'apple', to: 'A1' });
  const c = E.compileRules(rules);
  const text = 'Lorem ipsum dolor sit amet, apple consectetur adipiscing elit. '.repeat(15000);
  const t0 = process.hrtime.bigint();
  const res = E.replaceText(c, text);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(res.count, 15000);
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
});
