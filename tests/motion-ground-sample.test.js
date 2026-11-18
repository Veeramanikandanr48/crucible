import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { sampleMotionAtZeroForGround } from '../scripts/motion-ground-sample.js';

// Issue 2051: scene_look with motionTime 1 on a scene with nothing to animate reported "time: got 0".

const recipe = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'paint', color: [0.8, 0.2, 0.2] }],
  nodes: [{ id: 'box', geometry: 'cube', material: 'paint' }],
};

test('a scene with nothing to sample refuses the motionTime the caller sent, not a time of 0', () => {
  const scene = createAgentScene(recipe);
  assert.throws(() => sampleMotionAtZeroForGround(scene, 1), error => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /^motionTime: got 1; expected null, because this scene has no motion/);
    assert.equal(error.fieldPath, 'motionTime');
    return true;
  });
});

test('an error that is not about the sampled time passes through unchanged', () => {
  const failure = new TypeError('boom');
  const scene = { sampleMotion() { throw failure; } };
  assert.throws(() => sampleMotionAtZeroForGround(scene, 1), error => error === failure);
});
