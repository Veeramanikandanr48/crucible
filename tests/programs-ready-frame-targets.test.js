import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';

function fakeRenderer() {
  const calls = [];
  return {
    calls,
    disposed: false,
    pendingConstruction: { pending: {} },
    pendingEnvironmentPrograms: null,
    initialTargetsPending: null,
    context: { getExtension: () => null },
    finishConstruction(options) {
      calls.push(options?.deferFrameTargets ? 'finishConstruction:deferred' : 'finishConstruction');
      this.pendingConstruction = null;
    },
    allocateInitialTargets() { calls.push('allocateInitialTargets'); },
  };
}

const programsReady = renderer => CrucibleRenderer.prototype.programsReady.call(renderer);

test('programsReady allocates the frame targets in a task of their own after construction finishes (#779)', async () => {
  const renderer = fakeRenderer();
  const ready = programsReady(renderer);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  assert.deepEqual(renderer.calls, ['finishConstruction:deferred'], 'the targets wait for a timer task');
  await ready;
  assert.deepEqual(renderer.calls, ['finishConstruction:deferred', 'allocateInitialTargets']);
});

test('a second programsReady waits for the targets the first one is still allocating', async () => {
  const renderer = fakeRenderer();
  const first = programsReady(renderer);
  await Promise.resolve();
  const second = programsReady(renderer);
  await second;
  assert.deepEqual(renderer.calls, ['finishConstruction:deferred', 'allocateInitialTargets']);
  await first;
});

test('programsReady on a renderer disposed during the wait allocates nothing', async () => {
  const renderer = fakeRenderer();
  renderer.allocateInitialTargets = CrucibleRenderer.prototype.allocateInitialTargets;
  const ready = programsReady(renderer);
  renderer.disposed = true;
  await ready;
  assert.deepEqual(renderer.calls, ['finishConstruction:deferred']);
});
