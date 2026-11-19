import assert from 'node:assert/strict';
import test from 'node:test';

async function readOption(search, fallback = 1280, minimum = 64, maximum = 4096) {
  const { readWholeNumberOption } = await import('../src/query-number-option.js');
  return readWholeNumberOption(new URLSearchParams(search), 'width', fallback, minimum, maximum);
}

test('a missing, empty or blank page option uses its default instead of the minimum', async () => {
  assert.equal(await readOption(''), 1280);
  assert.equal(await readOption('width='), 1280);
  assert.equal(await readOption('width=%20%20'), 1280);
});

test('a value that is not a number uses the default', async () => {
  assert.equal(await readOption('width=wide'), 1280);
  assert.equal(await readOption('width=Infinity'), 1280);
});

test('a fractional page option is rounded to a whole number so the renderer accepts it', async () => {
  assert.equal(await readOption('width=2.5', 4, 1, 8), 3);
  assert.equal(await readOption('width=100.4'), 100);
});

test('a page option stays inside its range', async () => {
  assert.equal(await readOption('width=1'), 64);
  assert.equal(await readOption('width=99999'), 4096);
  assert.equal(await readOption('width=800'), 800);
});
