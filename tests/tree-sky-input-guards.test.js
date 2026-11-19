import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrownSkyField, vertexCoverage } from '../src/tree-sky.js';

const TRIANGLE = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

test('createCrownSkyField refuses a NaN or infinite vertex instead of returning NaN visibility', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    const positions = new Float32Array([0, 0, 0, bad, 1, 1, 1, 1, 1]);
    assert.throws(() => createCrownSkyField(positions), /3 finite floats/);
  }
});

test('createCrownSkyField names the fix for a missing position list', () => {
  assert.throws(() => createCrownSkyField(null), /3 finite floats/);
  assert.throws(() => createCrownSkyField(undefined), /3 finite floats/);
});


test('vertexCoverage refuses an index outside the vertex list instead of returning NaN', () => {
  assert.throws(() => vertexCoverage(TRIANGLE, new Uint32Array([0, 1, 7])), /below 3/);
});

test('vertexCoverage refuses a partial triangle', () => {
  assert.throws(() => vertexCoverage(TRIANGLE, new Uint32Array([0, 1, 2, 0])), /multiple of 3/);
});

test('vertexCoverage still gives a third of the area to each corner of a valid triangle', () => {
  const coverage = vertexCoverage(TRIANGLE, new Uint32Array([0, 1, 2]));
  assert.deepEqual(Array.from(coverage), [1 / 6, 1 / 6, 1 / 6].map(Math.fround));
});
