import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseDocMediaExamples, selectDocMediaPages } from '../scripts/doc-media-examples.mjs';
import { parseCommandLine } from '../scripts/drive-features.mjs';
import { summarize } from '../scripts/generate-llms.mjs';

const learnFolder = new URL('../docs/learn/', import.meta.url);

test('every learn page still parses for the doc media renderer', () => {
  for (const file of readdirSync(learnFolder).filter(name => name.endsWith('.md'))) {
    assert.doesNotThrow(() => parseDocMediaExamples(file, readFileSync(new URL(file, learnFolder), 'utf8')), file);
  }
});

test('doc media: a poster name cannot leave the output folder', () => {
  assert.throws(() => parseDocMediaExamples('page', '```js live poster=../../escape\n```\n'), /plain file name/);
  assert.deepEqual(parseDocMediaExamples('page', '```js live poster=hero-1\n```\n'), [{ poster: 'hero-1', loopSeconds: 0 }]);
});

test('doc media: a shown WebM needs a loop length', () => {
  const page = '![](/docs-media/spin.webm)\n```js live poster=spin\n```\n';
  assert.throws(() => parseDocMediaExamples('page', page), /loop=<seconds>/);
  assert.throws(() => parseDocMediaExamples('page', page.replace('poster=spin', 'poster=spin loop=0')), /loop=<seconds>/);
  assert.deepEqual(parseDocMediaExamples('page', page.replace('poster=spin', 'poster=spin loop=4')), [{ poster: 'spin', loopSeconds: 4 }]);
});

test('doc media: an unknown page id is refused instead of rendering nothing', () => {
  assert.throws(() => selectDocMediaPages(['a', 'b'], ['c']), /No learn page named c; pass one of: a, b/);
  assert.deepEqual(selectDocMediaPages(['a', 'b'], ['b']), ['b']);
  assert.deepEqual(selectDocMediaPages(['a', 'b'], []), ['a', 'b']);
});

test('driver: a value flag does not swallow the next flag', () => {
  assert.throws(() => parseCommandLine(['shot', 'object', '--out', '--full-page']), /--out needs a value, not --full-page/);
  assert.throws(() => parseCommandLine(['shot', 'object', '--out']), /--out needs a value/);
  assert.deepEqual(parseCommandLine(['shot', 'object', '--out', 'a.png', '--full-page']).flags, { out: 'a.png', 'full-page': true });
});

test('driver: sizes and settle time must be numbers', () => {
  assert.throws(() => parseCommandLine(['shot', 'object', '--width', 'abc']), /--width must be a number of at least 1/);
  assert.throws(() => parseCommandLine(['shot', 'object', '--height', '0']), /--height must be a number/);
  assert.equal(parseCommandLine(['shot', 'object', '--settle', '0']).flags.settle, '0');
});

test('llms summary: e.g. and i.e. do not end the sentence', () => {
  assert.equal(summarize('Use e.g. a box to start. Then more.'), 'Use e.g. a box to start.');
  assert.equal(summarize('Pass the id, i.e. the stable one. Next.'), 'Pass the id, i.e. the stable one.');
});

test('llms summary: a cut never leaves an unclosed code span', () => {
  const description = `Call ${'word '.repeat(24)}with \`set material and more words\` after that and then some more text.`;
  const summary = summarize(description);
  assert.ok(summary.endsWith('...'));
  assert.equal(summary.split('`').length % 2, 1, summary);
});
