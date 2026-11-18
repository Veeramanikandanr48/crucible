import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANNOTATE_LIMITS } from '../src/agent-annotate.js';
import { REVIEW_FILE_FORMAT, REVIEW_LINK_LIMITS, newReviewId, parseReviewFile, reviewFileText, validateReviewMarks } from '../src/review-link.js';
import { reviewPageHtml, writeReviewBuild } from '../scripts/review-page.mjs';
import { openReviewPage } from './support/review-page-dom.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const view = { width: 768, height: 512 };

test('a saved review file reads back to the marks it was saved from', () => {
  const reviewId = newReviewId();
  const text = reviewFileText(reviewId, [{ x: 10, y: 20, note: 'dull', extra: 1 }]);
  assert.deepEqual(parseReviewFile(text), { reviewId, marks: [{ x: 10, y: 20, note: 'dull' }] });
});

test('parseReviewFile refuses what is not a review file and says what to pass instead', () => {
  const reviewId = newReviewId();
  const marks = [{ x: 1, y: 1, note: '' }];
  const refused = [
    [undefined, /text of the file/],
    ['{nope', /not JSON/],
    ['[]', /JSON object/],
    [JSON.stringify({ format: 'other', version: 1, reviewId, marks }), /crucible\.review/],
    [JSON.stringify({ format: REVIEW_FILE_FORMAT, version: 2, reviewId, marks }), /version 1/],
    [JSON.stringify({ format: REVIEW_FILE_FORMAT, version: 1, reviewId: 'abc', marks }), /32 hexadecimal/],
    [JSON.stringify({ format: REVIEW_FILE_FORMAT, version: 1, reviewId, marks, camera: {} }), /unknown field "camera"/],
    [' '.repeat(REVIEW_LINK_LIMITS.maxFileBytes + 1), /over 16384 bytes/],
  ];
  for (const [text, message] of refused) assert.throws(() => parseReviewFile(text), message);
});

test('validateReviewMarks applies the local annotate limits and needs one mark', () => {
  assert.deepEqual(validateReviewMarks([{ x: 5.04, y: 6, note: ' warmer ' }], view), [{ x: 5, y: 6, note: 'warmer' }]);
  assert.throws(() => validateReviewMarks([], view), /no marks/);
  assert.throws(() => validateReviewMarks([{ x: 769, y: 0, note: '' }], view), /mark 1 x/);
  assert.throws(() => validateReviewMarks(Array(ANNOTATE_LIMITS.maxMarks + 1).fill({ x: 1, y: 1, note: '' }), view), /at most 16 marks/);
});

test('the review page escapes its title and carries no remote address', () => {
  const html = reviewPageHtml({ title: '<img src=x onerror=alert(1)>', ...view, reviewId: newReviewId() });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /name="viewport"/);
});

test('writeReviewBuild writes index.html and frame.png only', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-review-page-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputDirectory = join(directory, 'web-test');
  const summary = await writeReviewBuild({ frame: { data: PNG, ...view }, outputDirectory, title: 'Kitchen', reviewId: newReviewId() });
  assert.equal(summary.files, 2);
  assert.deepEqual(Buffer.from(PNG, 'base64'), await readFile(join(outputDirectory, 'frame.png')));
  assert.match(await readFile(join(outputDirectory, 'index.html'), 'utf8'), /<title>Kitchen<\/title>/);
});

test('the page pins on a tap, ignores a two finger touch and saves the file the reader accepts', () => {
  const reviewId = newReviewId();
  const page = openReviewPage(reviewPageHtml({ title: 'Kitchen', ...view, reviewId }));
  assert.equal(page.elements.download.disabled, true);
  page.tap(100, 50);
  page.twoFingerTap(300, 300);
  page.tap(700.04, 400);
  page.write(1, '  warmer light  ');
  assert.equal(page.elements.rows.children.length, 2);
  assert.equal(page.elements.download.disabled, false);
  const parsed = parseReviewFile(page.saveFileText());
  assert.equal(parsed.reviewId, reviewId);
  assert.deepEqual(validateReviewMarks(parsed.marks, view), [{ x: 100, y: 50, note: 'warmer light' }, { x: 700, y: 400, note: '' }]);
});

test('the page stops at the pin limit', () => {
  const page = openReviewPage(reviewPageHtml({ title: '', ...view, reviewId: newReviewId() }));
  for (let index = 0; index < ANNOTATE_LIMITS.maxMarks + 4; index++) page.tap(10 + index, 10);
  assert.equal(page.elements.rows.children.length, ANNOTATE_LIMITS.maxMarks);
});

test('validateReviewMarks keeps the page limit of 16 marks whatever maxMarks the caller passes', () => {
  const seventeenMarks = Array.from({ length: 17 }, (unused, index) => ({ x: index, y: 1, note: '' }));
  assert.throws(() => validateReviewMarks(seventeenMarks, { width: 64, height: 48, maxMarks: 32 }), /at most 16 marks/);
  assert.equal(validateReviewMarks(seventeenMarks.slice(0, 16), { width: 64, height: 48, maxMarks: 32 }).length, 16);
});
