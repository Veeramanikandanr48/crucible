import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';

const BLOOM_FRAME = { effects: { bloom: { strength: 0.4 } } };

function fakeRenderer(overrides = {}) {
  const calls = [];
  return {
    calls,
    benchmark: false,
    disposed: false,
    bloomTargets: [],
    context: {},
    programsReady: async () => { calls.push('programsReady'); },
    ensureBloomTargets() { calls.push('ensureBloomTargets'); },
    render: () => { calls.push('render'); },
    ...overrides,
  };
}

const prepare = (renderer, frame) => CrucibleRenderer.prototype.prepareFrame.call(renderer, frame);

test('prepareFrame allocates the bloom targets in a task of their own, after the programs and before the draw (#779)', async () => {
  const renderer = fakeRenderer();
  const preparing = prepare(renderer, BLOOM_FRAME);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  assert.deepEqual(renderer.calls, ['programsReady'], 'the allocation waits for a timer task, it does not run inside the caller');
  assert.equal(await preparing, true);
  assert.deepEqual(renderer.calls, ['programsReady', 'ensureBloomTargets', 'render']);
});

test('prepareFrame allocates no bloom targets for a frame without bloom, a benchmark renderer or existing targets', async () => {
  for (const [renderer, frame] of [
    [fakeRenderer(), { effects: { bloom: { strength: 0 } } }],
    [fakeRenderer(), {}],
    [fakeRenderer({ benchmark: true }), BLOOM_FRAME],
    [fakeRenderer({ bloomTargets: [{}, {}] }), BLOOM_FRAME],
  ]) {
    assert.equal(await prepare(renderer, frame), true);
    assert.deepEqual(renderer.calls, ['programsReady', 'render']);
  }
});

test('prepareFrame on a renderer disposed while the allocation waits builds and draws nothing', async () => {
  const renderer = fakeRenderer();
  const preparing = prepare(renderer, BLOOM_FRAME);
  renderer.disposed = true;
  assert.equal(await preparing, false);
  assert.deepEqual(renderer.calls, ['programsReady']);
});
