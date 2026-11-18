import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  communityEntryProblems,
  communityFigureMarkup,
  parseFeatured,
  renderCommunity,
  submitEmailUrl,
  SUBMIT_URL,
} from '../src/community-showcase.js';

const VALID_ENTRY = Object.freeze({
  title: 'Night market',
  author: 'Ada Lovelace',
  authorUrl: 'https://x.com/ada',
  discussion: 'https://github.com/codepawl/crucible/discussions/12',
  image: '/community/night-market.webp',
  width: 1600,
  height: 900,
  alt: 'A night market street with lanterns, rendered by Crucible',
  assets: 'Own models; HDRI from Poly Haven (CC0)',
});

test('the committed featured.json is valid and every still is on disk', () => {
  const data = JSON.parse(readFileSync(new URL('../public/community/featured.json', import.meta.url), 'utf8'));
  for (const entry of parseFeatured(data)) {
    readFileSync(new URL(`../public${entry.image}`, import.meta.url));
  }
});

test('a complete entry has no problems, with or without a live link', () => {
  assert.deepEqual(communityEntryProblems(VALID_ENTRY), []);
  assert.deepEqual(communityEntryProblems({ ...VALID_ENTRY, link: 'https://example.com/scene' }), []);
});

test('each bad field is named with what to pass instead', () => {
  const problems = communityEntryProblems({
    ...VALID_ENTRY,
    title: '',
    authorUrl: 'http://x.com/ada',
    discussion: 'https://github.com/other/repo/discussions/1',
    image: 'https://cdn.example.com/still.webp',
    width: 0,
    link: 'javascript:alert(1)',
    assets: 'x'.repeat(161),
  });
  assert.equal(problems.length, 7);
  assert.match(problems.join(' '), /"title".*"assets".*"authorUrl".*"discussion".*"image".*"width".*"link"/);
  assert.deepEqual(communityEntryProblems(null), ['an entry must be an object']);
  assert.deepEqual(communityEntryProblems([]), ['an entry must be an object']);
});

test('parseFeatured rejects a wrong shape, too many entries and bad entries', () => {
  assert.throws(() => parseFeatured({}), /must be \{ "entries"/);
  assert.throws(() => parseFeatured({ entries: Array(61).fill(VALID_ENTRY) }), /keep it to 60/);
  assert.throws(() => parseFeatured({ entries: [VALID_ENTRY, { ...VALID_ENTRY, height: 1.5 }] }), /entry 2: "height"/);
  assert.deepEqual(parseFeatured({ entries: [VALID_ENTRY] }), [VALID_ENTRY]);
});

test('the figure escapes text and links the still to the live page, else the discussion', () => {
  const markup = communityFigureMarkup({ ...VALID_ENTRY, title: '<b>Night</b> & "market"' });
  assert.match(markup, /&lt;b&gt;Night&lt;\/b&gt; &amp; &quot;market&quot;/);
  assert.match(markup, /class="community-still" href="https:\/\/github\.com\/codepawl\/crucible\/discussions\/12"/);
  const linked = communityFigureMarkup({ ...VALID_ENTRY, link: 'https://example.com/scene' });
  assert.match(linked, /class="community-still" href="https:\/\/example\.com\/scene"/);
  assert.match(linked, /By <a href="https:\/\/x\.com\/ada">Ada Lovelace<\/a>/);
});

test('the email link carries the subject and the permission line', () => {
  const url = submitEmailUrl();
  assert.match(url, /^mailto:hello@codepawl\.com\?subject=Crucible%20showcase%20submission&body=/);
  assert.match(decodeURIComponent(url), /CodePawl may show this picture/);
  assert.match(SUBMIT_URL, /discussions\/new\?category=show-and-tell$/);
});

test('renderCommunity fills the grid, and hides it when the list is empty or fails', async () => {
  const grid = { innerHTML: '', hidden: true };
  const emailLink = { href: '' };
  assert.equal(await renderCommunity({ grid, emailLink, fetchJson: async () => ({ entries: [VALID_ENTRY] }) }), 1);
  assert.equal(grid.hidden, false);
  assert.match(grid.innerHTML, /Night market/);
  assert.match(emailLink.href, /^mailto:/);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(await renderCommunity({ grid, fetchJson: async () => { throw new Error('offline'); } }), 0);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(grid.hidden, true);
  assert.equal(grid.innerHTML, '');
  assert.match(warnings[0], /offline/);
});
