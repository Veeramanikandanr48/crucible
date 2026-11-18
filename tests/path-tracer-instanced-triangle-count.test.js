import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTraceScene, measureInstanceExpansion } from '../src/path-tracer-scene.js';

const QUADS_PER_SIDE = 10;
const TRIANGLES_PER_MESH = QUADS_PER_SIDE * QUADS_PER_SIDE * 2;
const MESH_COUNT = 3;
const COPIES_PER_MESH = 3;
const ENVIRONMENT = { keyColor: [1, 1, 1], lightDirection: [0, 1, 0] };

function gridGeometry() {
  const side = QUADS_PER_SIDE + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      positions.set([column * 0.1, row * 0.1, 0], (row * side + column) * 3);
      normals.set([0, 0, 1], (row * side + column) * 3);
    }
  }
  const indices = new Uint32Array(TRIANGLES_PER_MESH * 3);
  let slot = 0;
  for (let row = 0; row < QUADS_PER_SIDE; row++) {
    for (let column = 0; column < QUADS_PER_SIDE; column++) {
      const corner = row * side + column;
      indices.set([corner, corner + 1, corner + side, corner + 1, corner + side + 1, corner + side], slot);
      slot += 6;
    }
  }
  return { positions, normals, indices };
}

// Nine nodes that share three geometries, like nine placed copies of three GLBs.
function instancedNodes() {
  const sharedGeometries = Array.from({ length: MESH_COUNT }, gridGeometry);
  return sharedGeometries.flatMap((geometry, meshIndex) => Array.from({ length: COPIES_PER_MESH }, (_, copyIndex) => ({
    name: `mesh-${meshIndex}-copy-${copyIndex}`,
    geometry,
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, copyIndex * 2, meshIndex * 2, 0, 1]),
    material: { color: [0.8, 0.7, 0.6] },
  })));
}

const EXPANDED_TRIANGLES = MESH_COUNT * COPIES_PER_MESH * TRIANGLES_PER_MESH;
const UNIQUE_TRIANGLES = MESH_COUNT * TRIANGLES_PER_MESH;

test('the expansion counts the nodes that share geometry and the triangles once per shared geometry', () => {
  const parts = instancedNodes();
  const lone = { name: 'lone', geometry: gridGeometry(), material: { color: [1, 1, 1] } };
  const geometries = [...parts, lone].map(part => part.geometry);
  assert.deepEqual(measureInstanceExpansion([...parts, lone], geometries), {
    instancedNodes: MESH_COUNT * COPIES_PER_MESH,
    uniqueTriangles: UNIQUE_TRIANGLES + TRIANGLES_PER_MESH,
  });
});

test('a gpu trace of instanced copies is refused with the expanded and the unique count and the way out', () => {
  assert.ok(EXPANDED_TRIANGLES > UNIQUE_TRIANGLES * 2);
  assert.throws(() => buildTraceScene(instancedNodes(), ENVIRONMENT, { gpuTriangleLimit: UNIQUE_TRIANGLES * 2 }), (error) => {
    assert.equal(error.name, 'RangeError');
    assert.match(error.message, new RegExp(`got ${EXPANDED_TRIANGLES}\\.`));
    assert.match(error.message, new RegExp(`${EXPANDED_TRIANGLES} triangles after expanding 9 instanced nodes \\(${UNIQUE_TRIANGLES} unique\\)`));
    assert.match(error.message, /fewer copies, a simpler GLB, or the Glaze renderer/);
    return true;
  });
});

test('a scene without shared geometry keeps its old message', () => {
  const cpuParts = Array.from({ length: 2 }, (_, index) => ({ name: `big-${index}`, geometry: gridGeometry(), material: { color: [1, 1, 1] } }));
  assert.doesNotThrow(() => buildTraceScene(cpuParts, ENVIRONMENT));
  assert.throws(() => buildTraceScene(cpuParts, ENVIRONMENT, { gpuTriangleLimit: TRIANGLES_PER_MESH }), (error) => {
    assert.doesNotMatch(error.message, /instanced nodes/);
    return true;
  });
});

test('the same copies are accepted when the limit holds every expanded triangle', () => {
  const scene = buildTraceScene(instancedNodes(), ENVIRONMENT, { gpuTriangleLimit: EXPANDED_TRIANGLES });
  assert.equal(scene.indices.length / 3, EXPANDED_TRIANGLES);
});
