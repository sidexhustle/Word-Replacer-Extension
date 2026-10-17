/**
 * settings.test.js — Unit tests for extension/src/shared/settings.js (node:test, no dependencies).
 *
 * Purpose: verify sanitizing, site matching, rule upsert/merge and the portable rules-file format
 * (including the bundled extension/rules.json shipped in the repo).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../extension/src/shared/settings.js');

test('defaults: enabled, all surfaces on, no sites, no rules', () => {
  const d = S.defaultSettings();
  assert.equal(d.enabled, true);
  assert.deepEqual(Object.keys(d.surfaces).sort(), [...S.SURFACE_KEYS].sort());
  assert.ok(Object.values(d.surfaces).every(Boolean));
  assert.deepEqual(d.disabledSites, []);
  assert.deepEqual(d.rules, []);
});

test('sanitizeSettings repairs bad input and drops invalid rules', () => {
  const s = S.sanitizeSettings({
    enabled: 'yes',
    surfaces: { title: false, bogus: true, tooltips: 'no' },
    disabledSites: ['https://WWW.Example.org/news', 'bad host!', 'mail.google.com', 'example.org'],
    rules: [{ from: 'apple', to: 'A1' }, { from: '', to: 'x' }, null, { from: 'a', to: 'b', id: 'same' }, { from: 'c', to: 'd', id: 'same' }],
  });
  assert.equal(s.enabled, true);
  assert.equal(s.surfaces.title, false);
  assert.equal(s.surfaces.tooltips, true);
  assert.equal('bogus' in s.surfaces, false);
  assert.deepEqual(s.disabledSites, ['example.org', 'mail.google.com']);
  assert.equal(s.rules.length, 3);
  assert.ok(s.rules.every((r) => r.id));
  assert.equal(new Set(s.rules.map((r) => r.id)).size, 3);
});

test('normalizeSite accepts URLs and hostnames, rejects junk', () => {
  assert.equal(S.normalizeSite('https://www.Example.com:8080/path?q=1'), 'example.com');
  assert.equal(S.normalizeSite('*.example.org'), 'example.org');
  assert.equal(S.normalizeSite('localhost'), 'localhost');
  assert.equal(S.normalizeSite('not a site'), '');
  assert.equal(S.normalizeSite(''), '');
});

test('isSiteDisabled matches the site and its subdomains only', () => {
  const s = { disabledSites: ['google.com'] };
  assert.equal(S.isSiteDisabled(s, 'google.com'), true);
  assert.equal(S.isSiteDisabled(s, 'mail.google.com'), true);
  assert.equal(S.isSiteDisabled(s, 'notgoogle.com'), false);
  assert.equal(S.isSiteDisabled(s, ''), false);
});

test('matchingSites lists the entries that turn a website off', () => {
  const s = { disabledSites: ['google.com', 'mail.google.com', 'example.org'] };
  assert.deepEqual(S.matchingSites(s, 'mail.google.com'), ['google.com', 'mail.google.com']);
  assert.deepEqual(S.matchingSites(s, 'www.example.org'), ['example.org']);
  assert.deepEqual(S.matchingSites(s, 'example.com'), []);
});

test('setSiteDisabled turns a website off and back on', () => {
  let list = S.setSiteDisabled([], 'www.Example.org', true);
  assert.deepEqual(list, ['example.org'], 'stored without www., so all of example.org is covered');
  assert.deepEqual(S.setSiteDisabled(list, 'de.example.org', true), ['example.org'], 'already covered: no duplicate');
  list = S.setSiteDisabled(['example.org', 'example.com'], 'www.example.org', false);
  assert.deepEqual(list, ['example.com']);
  assert.deepEqual(S.setSiteDisabled(['google.com', 'mail.google.com'], 'mail.google.com', false), [], 'every covering entry removed');
  assert.deepEqual(S.setSiteDisabled(['example.com'], 'other.org', false), ['example.com'], 'unrelated entries kept');
});

test('upsertRule updates by find text (ignoring case) or appends', () => {
  let rules = [{ id: '1', from: 'apple', to: 'A1', match: 'wordStart', enabled: true }];
  rules = S.upsertRule(rules, { from: 'APPLE', to: 'A2', match: 'wholeWord' });
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0], { id: '1', from: 'apple', to: 'A2', match: 'wholeWord', enabled: true });
  rules = S.upsertRule(rules, { from: 'banana', to: 'B2' });
  assert.equal(rules.length, 2);
  assert.ok(rules[1].id);
});

test('mergeRules: incoming wins for the same word, others appended, existing kept', () => {
  const existing = [
    { id: '1', from: 'apple', to: 'A1', match: 'wordStart', enabled: true },
    { id: '2', from: 'keep', to: 'k', match: 'wordStart', enabled: true },
  ];
  const merged = S.mergeRules(existing, [
    { from: 'Apple', to: 'A1!', match: 'wordStart' },
    { from: 'new', to: 'n' },
  ]);
  assert.deepEqual(merged.map((r) => [r.from, r.to]), [['apple', 'A1!'], ['keep', 'k'], ['new', 'n']]);
  assert.equal(merged[0].id, '1');
});

test('portable round trip keeps rules and portable settings but not the on/off switch', () => {
  const s = S.sanitizeSettings({
    enabled: false,
    surfaces: { altText: false },
    disabledSites: ['example.com'],
    rules: [{ from: 'apple', to: 'A1', match: 'wholeWord', enabled: false }],
  });
  const file = JSON.parse(JSON.stringify(S.toPortable(s)));
  assert.equal(file.format, S.PORTABLE_FORMAT);
  assert.equal('enabled' in file.settings, false);
  assert.deepEqual(file.rules, [{ from: 'apple', to: 'A1', match: 'wholeWord', enabled: false }]);
  const parsed = S.parsePortable(JSON.stringify(file));
  assert.equal(parsed.rules[0].from, 'apple');
  assert.equal(parsed.rules[0].match, 'wholeWord');
  assert.equal(parsed.settings.surfaces.altText, false);
  assert.deepEqual(parsed.settings.disabledSites, ['example.com']);
});

test('parsePortable accepts an array of rules and a simple {find: replacement} map', () => {
  assert.equal(S.parsePortable([{ from: 'a', to: 'b' }]).rules.length, 1);
  const map = S.parsePortable('{"apple": "A1", "banana": "B2"}');
  assert.deepEqual(map.rules.map((r) => [r.from, r.to, r.match]), [
    ['apple', 'A1', 'anywhere'],
    ['banana', 'B2', 'anywhere'],
  ]);
  assert.equal(map.settings, null);
});

test('parsePortable reports skipped rules and rejects foreign files', () => {
  assert.equal(S.parsePortable({ rules: [{ from: 'ok', to: '1' }, { from: '' }] }).skipped, 1);
  assert.throws(() => S.parsePortable('not json'), SyntaxError);
  assert.throws(() => S.parsePortable({ format: 'other', rules: [] }), /Unknown format/);
  assert.throws(() => S.parsePortable({ nope: 1 }), /Not a Word Replacer rules file/);
});

test('the bundled extension/rules.json holds the 3 example rules (one per match mode, switched off)', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../extension/rules.json'), 'utf8');
  const parsed = S.parsePortable(text);
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsed.rules.map((r) => [r.from, r.to, r.match, r.enabled]), [
    ['color', 'colour', 'anywhere', false],
    ['organize', 'organise', 'wordStart', false],
    ['gray', 'grey', 'wholeWord', false],
  ]);
});

test('sha256Hex produces a stable hex digest', async () => {
  assert.equal(await S.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
