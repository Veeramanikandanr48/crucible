import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { curve, curveSet } from '../src/modeling.js';

await loadAllAgentSceneModules();

const POINTS = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];

function recipeWith(geometry) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }, { id: 'part', type: 'curve', ...geometry }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'part', geometry: 'part', material: 'paint' }],
  };
}

// Each row: the geometry, the field path the agent must see, what it received, the example and the field that must not be blamed.
const CASES = [
  ['curve with a closed flag that is not a boolean', { points: POINTS, closed: 'yes' }, 'geometries[1].closed', '"yes"', 'true or false, such as false', /radius/],
  ['curve with radius 0', { points: POINTS, radius: 0 }, 'geometries[1].radius', '0', 'a number above 0, such as 0.05', /closed/],
  ['curve with a negative radius', { points: POINTS, radius: -2 }, 'geometries[1].radius', '-2', 'a number above 0, such as 0.05', /closed/],
  ['curve with splines and a closed flag that is not a boolean', { splines: [{ points: POINTS }, { points: POINTS, closed: 1 }] }, 'geometries[1].splines[1].closed', '1', 'true or false, such as false', /radius/],
  ['curve with splines and radius 0', { splines: [{ points: POINTS }], radius: 0 }, 'geometries[1].radius', '0', 'a number above 0, such as 0.05', /closed/],
  ['curve with kind and a closed flag that is not a boolean', { points: POINTS, kind: 'poly', closed: null }, 'geometries[1].closed', 'null', 'true or false, such as false', /radius/],
];

for (const [name, geometry, path, received, example, notBlamed] of CASES) {
  test(`${name} names its field, the value received and an example`, () => {
    assert.throws(() => createAgentScene(recipeWith(geometry), {}, {}), error => {
      assert.ok(error.message.startsWith(`${path}: got ${received}; expected ${example}`), `message was: ${error.message}`);
      assert.equal(error.fieldPath, path);
      assert.doesNotMatch(error.message.slice(path.length), notBlamed);
      return true;
    });
  });
}

test('the curve builders called directly name the field without a geometries index', () => {
  assert.throws(() => curve(POINTS, { closed: 'yes' }), /^TypeError: closed: got "yes"; expected true or false, such as false\.$/);
  assert.throws(() => curve(POINTS, { radius: 0 }), /^RangeError: radius: got 0; expected a number above 0, such as 0\.05\.$/);
  assert.throws(() => curveSet([{ points: POINTS }, { points: POINTS, closed: 'no' }]), /^TypeError: splines\[1\]\.closed: got "no"; expected true or false/);
  assert.throws(() => curveSet([{ points: POINTS }], { radius: -1 }), /^RangeError: radius: got -1; expected a number above 0/);
});
