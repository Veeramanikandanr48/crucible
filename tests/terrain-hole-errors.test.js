import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { recipeDiagnostics } from '../src/agent-diagnostics.js';
import { exportGlb } from '../src/export.js';
import { holesRemovingNoCell } from '../src/terrain-hole-cells.js';
import { box } from '../src/geometry.js';

function terrainRecipe(terrain) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box' }, { id: 'ground', type: 'terrain', ...terrain }],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'land', geometry: 'ground', material: 'stone' }],
  };
}

function holeDiagnostics(terrain) {
  const recipe = createAgentScene(terrainRecipe(terrain)).exportRecipe();
  return recipeDiagnostics(recipe).filter(entry => entry.kind === 'terrain-hole-removes-no-cell');
}

test('holes that remove every cell are refused with the geometry, the cause and the fix', () => {
  assert.throws(
    () => createAgentScene(terrainRecipe({ holes: [{ center: [0, 0], radius: 100 }] })),
    error => /^geometries\[1\]\.holes: got \[.*cover the whole terrain.*Lower a radius or move a center/.test(error.message),
  );
});

test('several holes that together cover the ground are refused, one that leaves a cell is accepted', () => {
  const halves = [{ center: [-10, 0], radius: 25 }, { center: [10, 0], radius: 25 }];
  assert.throws(() => createAgentScene(terrainRecipe({ size: 40, resolution: 8, holes: halves })), /geometries\[1\]\.holes: got \[/);
  assert.doesNotThrow(() => createAgentScene(terrainRecipe({ size: 40, resolution: 8, holes: [{ center: [0, 0], radius: 24 }] })));
});

test('a hole smaller than a cell returns a warning with the cell size and the smallest radius that removes one', () => {
  const [problem] = holeDiagnostics({ holes: [{ center: [0, 0], radius: 0.01 }] });
  assert.equal(problem.severity, 'warning');
  assert.equal(problem.target, 'ground.holes[0]');
  assert.match(problem.message, /cells are 0\.625 m wide/);
  // Cell centres sit half a cell from the origin on both axes: 0.3125 * sqrt(2).
  assert.match(problem.fix, /above 0\.442 /);
});

test('the smallest radius the diagnostic names removes a cell, and a hole that removes one is not flagged', () => {
  const terrain = { size: 40, resolution: 64, holes: [{ center: [3.3, -7.1], radius: 0.01 }] };
  const [{ smallestRadius }] = holesRemovingNoCell(terrain);
  assert.deepEqual(holesRemovingNoCell({ ...terrain, holes: [{ center: [3.3, -7.1], radius: smallestRadius }] }), []);
  assert.deepEqual(holeDiagnostics({ holes: [{ center: [0, 0], radius: 2 }] }), []);
});

test('the GLB export names the part whose mesh has no triangles', () => {
  const geometry = { ...box(), indices: new Uint32Array(0) };
  const part = { name: 'emptyGround', geometry, material: { color: [1, 1, 1] } };
  assert.throws(() => exportGlb([part]), /GLB part emptyGround has no triangles.*holes may cover the whole ground/);
});
