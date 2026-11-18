import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { torus } from '../src/geometry.js';
import { extrude, lathe, tube } from '../src/modeling.js';

await loadAllAgentSceneModules();

function recipeWith(geometry) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }, { id: 'part', ...geometry }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'part', geometry: 'part', material: 'paint' }],
  };
}

const BOW_TIE = [[0, 0], [1, 1], [1, 0], [0, 1]];

// Each row: the geometry, the field path the agent must see, what it received, and a phrase of the fix with its example.
const CASES = [
  ['tube with a repeated point', { type: 'tube', path: [[0, 0, 0], [1, 0, 0], [1, 0, 0]] }, 'geometries[1].path[2]', '[1,0,0]', 'a point different from path[1], since consecutive duplicate points'],
  ['tube with radius 0', { type: 'tube', path: [[0, 0, 0], [1, 0, 0]], radius: 0 }, 'geometries[1].radius', '0', 'a number above 0, such as 0.1'],
  ['tube with a closed flag that is not a boolean', { type: 'tube', path: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: 'yes' }, 'geometries[1].closed', '"yes"', 'true or false'],
  ['lathe with only zero radii', { type: 'lathe', profile: [[0, 0], [0, 1]] }, 'geometries[1].profile', '[[0,0],[0,1]]', 'such as [[0, 0], [0.5, 1]]'],
  ['extrude with a bow-tie contour', { type: 'extrude', contour: BOW_TIE }, 'geometries[1].contour', '"segments 0 and 2 cross or touch"', 'segment 0 runs from contour[0] to contour[1] and segment 2 from contour[2] to contour[3]'],
  ['extrude with a repeated hole point', { type: 'extrude', contour: [[0, 0], [4, 0], [4, 4], [0, 4]], holes: [[[1, 1], [1, 1], [2, 1], [2, 2]]] }, 'geometries[1].holes[0][1]', '[1,1]', 'a point different from holes[0][0]'],
  ['torus with arc 0', { type: 'torus', arc: 0 }, 'geometries[1].arc', '0', 'a number above 0 and at most 6.283185307179586'],
  ['torus with tubeRadius 0', { type: 'torus', tubeRadius: 0 }, 'geometries[1].tubeRadius', '0', 'a positive number that is still above 0 as a Float32, such as 0.08'],
];

for (const [name, geometry, path, received, expectation] of CASES) {
  test(`${name} names its field, the value received and a fix`, () => {
    assert.throws(() => createAgentScene(recipeWith(geometry), {}, {}), error => {
      assert.ok(error.message.startsWith(`${path}: got ${received}; expected `), `message was: ${error.message}`);
      assert.ok(error.message.includes(expectation), `message was: ${error.message}`);
      assert.equal(error.fieldPath, path);
      return true;
    });
  });
}

test('a geometry nested as a mesh base reports the same field errors', () => {
  const recipe = recipeWith({ type: 'mesh', base: { type: 'tube', path: [[0, 0, 0], [1, 0, 0]], radius: -1 } });
  assert.throws(() => createAgentScene(recipe, {}, {}), /radius: got -1; expected a number above 0, such as 0\.1/);
});

test('the builders called directly report field paths without a geometries index', () => {
  assert.throws(() => tube([[0, 0, 0], [1, 0, 0]], { radius: 0 }), /^RangeError: radius: got 0; expected a number above 0/);
  assert.throws(() => tube([[0, 0, 0], [1, 0, 0]], { closed: 1 }), /^TypeError: closed: got 1; expected true or false/);
  assert.throws(() => lathe([[0, 0], [0, 1]]), /^RangeError: profile: got \[\[0,0\],\[0,1\]\]; expected points/);
  assert.throws(() => extrude(BOW_TIE), /^RangeError: contour: got "segments 0 and 2 cross or touch"; expected/);
  assert.throws(() => torus(0.08, 96, 24, 0), /^RangeError: arc: got 0; expected a number above 0/);
});
