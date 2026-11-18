import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function recipeWith(nodeTranslation, system = {}) {
  const node = { id: 'sparks', geometry: 'speck', material: 'glow' };
  if (nodeTranslation) node.translation = nodeTranslation;
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box', bevel: 0 }],
    materials: [{ id: 'glow', color: [1, 0.5, 0.1], emission: 4 }],
    nodes: [node],
    particles: { systems: [{ node: 'sparks', count: 100, rate: 30, lifetime: 2, speed: 3, ...system }] },
  };
}

function particleDiagnostics(recipe) {
  const inspection = createAgentScene(recipe).inspect({});
  return (inspection.diagnostics ?? []).filter(problem => problem.kind === 'particle-node-transform-ignored');
}

test('a translated system node without emitter.position says where its particles are born and what to set (#2053)', () => {
  const [problem] = particleDiagnostics(recipeWith([-1.5, 0.3, 0]));
  assert.equal(problem.target, 'sparks');
  assert.equal(problem.severity, 'warning');
  assert.match(problem.message, /world origin/);
  assert.match(problem.fix, /emitter\.position to \[-1\.5, 0\.3, 0\]/);
});

test('no particle diagnostic when the node sits at the origin, the emitter has a position or the emitter is a mesh', () => {
  assert.deepEqual(particleDiagnostics(recipeWith(null)), []);
  assert.deepEqual(particleDiagnostics(recipeWith([-1.5, 0.3, 0], { emitter: { shape: 'point', position: [-1.5, 0.3, 0] } })), []);
  const meshRecipe = recipeWith([2, 0, 0], { emitter: { shape: 'mesh', mesh: 'surface' } });
  meshRecipe.geometries.push({ id: 'plane', type: 'grid', segments: 2 });
  meshRecipe.nodes.push({ id: 'surface', geometry: 'plane', material: 'glow' });
  assert.deepEqual(particleDiagnostics(meshRecipe), []);
});
