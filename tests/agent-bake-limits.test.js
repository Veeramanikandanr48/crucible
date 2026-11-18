import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { bakeSecondsLimit } from '../src/agent-bake.js';
import { BAKE_PRESET_PATH_WORK, BAKE_EXPLICIT_PATH_WORK_LIMIT, BAKE_MAXIMUM_SECONDS, BAKE_WORKER_MAXIMUM_SECONDS } from '../src/agent-scene-capabilities.js';
import { largeRoom, oversizedRoom } from './support/agent-bake-rooms.mjs';

test('explicit settings over the hard limit shrink to fit it, keep every part baked and say what ran', () => {
  const heavy = { preset: 'draft', samples: 256, bounces: 3, texelsPerUnit: 12 };
  // A busy machine can pass the real limit here, and this test is about the settings, so the clock stands still.
  const realNow = performance.now;
  performance.now = () => 0;
  try {
    const bake = createAgentScene(largeRoom(heavy)).inspect().bake;
    const pathSteps = bake.texels * bake.used.samples * bake.used.bounces;
    assert.equal(bake.reduced, true);
    assert.ok(pathSteps <= BAKE_EXPLICIT_PATH_WORK_LIMIT && pathSteps > BAKE_PRESET_PATH_WORK, `${pathSteps} path steps`);
    assert.ok(bake.used.samples < 256 && bake.used.texelsPerUnit < 12, JSON.stringify(bake.used));
    assert.equal(bake.bakedParts, 56);
    assert.ok(bake.reduction.includes('samples 256, bounces 3, texelsPerUnit 12'), bake.reduction);
    assert.ok(bake.reduction.includes(`samples ${bake.used.samples}`), bake.reduction);
    assert.ok(bake.reduction.includes(String(BAKE_EXPLICIT_PATH_WORK_LIMIT)), bake.reduction);
  } finally {
    performance.now = realNow;
  }
});

test('a scene too large for the lowest explicit settings still fails up front and says why', () => {
  const heavy = { samples: 256, bounces: 3, texelsPerUnit: 12 };
  assert.throws(() => createAgentScene(oversizedRoom(heavy)), error => error instanceof RangeError
    && /^Even samples 16, bounces 1 and texelsPerUnit 1 is \d+ texels, over the 1000000 the bake takes\./.test(error.message));
});

test('explicit settings far above the preset budget run when they fit the hard limit, and are never reduced', () => {
  const explicit = { samples: 160, bounces: 2, texelsPerUnit: 6 };
  // A busy machine can pass the real limit here, and this test is about the settings, so the clock stands still.
  const realNow = performance.now;
  performance.now = () => 0;
  try {
    const bake = createAgentScene(largeRoom(explicit)).inspect().bake;
    assert.equal(bake.reduced, false);
    assert.deepEqual(bake.used, { ...explicit, probes: 'room' });
    assert.ok(bake.texels * explicit.samples * explicit.bounces > BAKE_PRESET_PATH_WORK);
  } finally {
    performance.now = realNow;
  }
});

test('an explicit bake that passes maxSeconds fails cleanly with a lower setting to try', () => {
  const slow = { samples: 256, bounces: 3, texelsPerUnit: 4 };
  // A fast machine finishes this bake inside the real limit, so each clock read is made to cost a second.
  const realNow = performance.now;
  let clockReads = 0;
  performance.now = () => {
    clockReads += 1;
    return realNow.call(performance) + clockReads * 1000;
  };
  try {
    // The advised samples follow how many clock reads the bake made, which follows the texel count, so the test pins that the advice is lower than the ask and not one number.
    assert.throws(() => createAgentScene(largeRoom(slow)), (error) => {
      const advised = Number(/Try samples (\d+)/.exec(error.message)?.[1]);
      return /maxSeconds/.test(error.message) && advised >= 1 && advised < slow.samples;
    });
  } finally {
    performance.now = realNow;
  }
});

test('the bake kernel carries 20 s on the page thread and 90 s inside a worker', () => {
  assert.equal(bakeSecondsLimit(), BAKE_MAXIMUM_SECONDS);
  globalThis.WorkerGlobalScope = Object;
  try {
    assert.equal(bakeSecondsLimit(), BAKE_WORKER_MAXIMUM_SECONDS);
  } finally {
    delete globalThis.WorkerGlobalScope;
  }
});
