import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';

// Issue 2116: joint, cubic keyframe and particle budget errors name the field, the value received and what to pass.

await loadPhysicsEngine();

function ball(id, x) {
  return { id, geometry: 'ball', material: 'paint', translation: [x, 1, 0] };
}

function jointRecipe(joint) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ball', type: 'sphere' }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [ball('a', 0), ball('b', 2)],
    physics: { duration: 1, bodies: [{ node: 'a' }, { node: 'b' }], joints: [joint] },
  };
}

test('a joint between a body and itself names bodyB and a body to pass instead', () => {
  assert.throws(() => createAgentScene(jointRecipe({ type: 'fixed', bodyA: 'a', bodyB: 'a' })),
    /physics\.joints\[0\]\.bodyB: got "a"; expected a body other than bodyA \("a"\), such as "b"\./);
});

test('a joint axis that is not a unit vector names the axis, the value and an example', () => {
  assert.throws(() => createAgentScene(jointRecipe({ type: 'revolute', bodyA: 'a', bodyB: 'b', axis: [0, 0, 0] })),
    /physics\.joints\[0\]\.axis: got \[0,0,0\]; expected a unit vector of length 1, such as \[0, 1, 0\] or \[1, 0, 0\]\./);
});

test('joint limits that do not increase name the field and give an example', () => {
  assert.throws(() => createAgentScene(jointRecipe({ type: 'revolute', bodyA: 'a', bodyB: 'b', axis: [0, 1, 0], limits: [2, 1] })),
    /physics\.joints\[0\]\.limits: got \[2,1\]; expected two numbers, the lower limit first and a gap a 32-bit float can store, such as \[-1, 1\]\./);
});

function cubicRecipe(keyframe) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ball', type: 'sphere' }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [ball('a', 0)],
    motion: { duration: 1, tracks: [{ kind: 'node', id: 'a', property: 'translation', interpolation: 'CUBICSPLINE', keyframes: [keyframe] }] },
  };
}

test('a cubic keyframe without tangents names the field and says to give both', () => {
  assert.throws(() => createAgentScene(cubicRecipe({ time: 0, value: [0, 0, 0] })),
    /motion\.tracks\[0\]\.keyframes\[0\]\.inTangent: got undefined; expected an array of 3 numbers, such as \[0, 0, 0\]; a CUBICSPLINE keyframe takes inTangent and outTangent/);
  assert.throws(() => createAgentScene(cubicRecipe({ time: 0, value: [0, 0, 0], inTangent: [0, 0, 0] })),
    /motion\.tracks\[0\]\.keyframes\[0\]\.outTangent: got undefined/);
});

test('a particle budget error names the vertices per particle and suggests bevel 0 for a default box', () => {
  const recipe = geometry => ({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [geometry],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'speck', geometry: 'shape', material: 'paint' }],
    particles: { systems: [{ node: 'speck', count: 200, lifetime: 1, speed: 1, emitter: { shape: 'point' } }] },
  });
  assert.throws(() => createAgentScene(recipe({ id: 'shape', type: 'box' })),
    /particles\.systems: got "235200 vertices"; expected at most 100000 vertices drawn in total; node speck draws 1176 vertices per particle times count 200, so use a shape with fewer vertices or a lower count; the shape is a box with a bevel, so pass "bevel": 0 on it to make it 24 vertices\./);
  assert.doesNotThrow(() => createAgentScene(recipe({ id: 'shape', type: 'box', bevel: 0 })));
  assert.throws(() => createAgentScene(recipe({ id: 'shape', type: 'sphere' })), error => !/bevel/.test(error.message) && /draws \d+ vertices per particle times count 200/.test(error.message));
});
