import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_VOLUME_TIMEOUT_FACTOR,
  operationsAddGridVolume,
  previewCallTimeoutMs,
  recipeHasGridVolume,
} from '../scripts/agent-evaluation-timeout.mjs';

const PLAIN_TIMEOUT_MS = 30000;
const BAKE_TIMEOUT_MS = 150000;

test('a grid volume in a created recipe is found, other volumes and recipes are not', () => {
  assert.equal(recipeHasGridVolume({ environment: { localVolumes: [{ shape: 'box' }, { shape: 'grid', grid: 'fireball.bin' }] } }), true);
  assert.equal(recipeHasGridVolume({ environment: { localVolumes: [{ shape: 'box' }, { shape: 'sphere' }] } }), false);
  assert.equal(recipeHasGridVolume({ environment: {} }), false);
  assert.equal(recipeHasGridVolume({}), false);
  assert.equal(recipeHasGridVolume(undefined), false);
});

test('an add-explosion operation counts as adding a grid volume, other operations do not', () => {
  assert.equal(operationsAddGridVolume([{ type: 'add-node' }, { type: 'add-explosion' }]), true);
  assert.equal(operationsAddGridVolume([{ type: 'add-node' }]), false);
  assert.equal(operationsAddGridVolume(undefined), false);
});

test('a call that adds a grid volume gets twice a plain call, and a bake keeps its own longer deadline', () => {
  const plain = previewCallTimeoutMs({ bakes: false, addsGridVolume: false, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS });
  const withGridVolume = previewCallTimeoutMs({ bakes: false, addsGridVolume: true, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS });
  const withBake = previewCallTimeoutMs({ bakes: true, addsGridVolume: true, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS });
  assert.equal(plain, PLAIN_TIMEOUT_MS);
  assert.equal(GRID_VOLUME_TIMEOUT_FACTOR, 2);
  assert.equal(withGridVolume, 2 * plain);
  assert.equal(withBake, BAKE_TIMEOUT_MS);
});
