import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function emptyRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box', bevel: 0 }],
    materials: [{ id: 'glow', color: [1, 0.5, 0.1], emission: 4 }],
    nodes: [],
  };
}

function applyBatch(scene, operations) {
  return scene.apply(operations, { expectedRevision: scene.revision });
}

test('a box emitter keeps no radius, and later batches still apply (#2203)', () => {
  const scene = createAgentScene(emptyRecipe());
  applyBatch(scene, [{ type: 'add-node', node: { id: 'cloud', geometry: 'speck', material: 'glow' } }]);
  applyBatch(scene, [{ type: 'set-particles', particles: { systems: [{ node: 'cloud', emitter: { shape: 'box', halfExtents: [1, 2, 1] } }] } }]);
  assert.equal('radius' in scene.exportRecipe().particles.systems[0].emitter, false, 'the stored box emitter has no radius');
  applyBatch(scene, [{ type: 'set-particles', particles: { systems: [{ node: 'cloud', count: 5, emitter: { shape: 'box', halfExtents: [1, 2, 1] } }] } }]);
  assert.equal(scene.inspect().particles.systems[0].particles, 5);
});

test('a stored box emitter holding the old radius default still loads (#2203)', () => {
  const recipe = emptyRecipe();
  recipe.nodes.push({ id: 'cloud', geometry: 'speck', material: 'glow' });
  recipe.particles = { systems: [{ node: 'cloud', emitter: { shape: 'box', halfExtents: [1, 1, 1], radius: 0.5 } }] };
  const scene = createAgentScene(recipe);
  assert.equal('radius' in scene.exportRecipe().particles.systems[0].emitter, false);
  assert.throws(() => createAgentScene({ ...recipe, particles: { systems: [{ node: 'cloud', emitter: { shape: 'box', radius: 2 } }] } }), /left out on a box/);
});

test('set-particles resolves a node added in an earlier batch (#2204)', () => {
  const scene = createAgentScene(emptyRecipe());
  applyBatch(scene, [{ type: 'add-node', node: { id: 'spray0', geometry: 'speck', material: 'glow' } }]);
  const topologyBefore = scene.topologyRevision;
  applyBatch(scene, [{ type: 'set-particles', particles: { systems: [{ node: 'spray0', seed: 11, count: 700, emitter: { shape: 'sphere', position: [-6.5, 0.4, 6], radius: 2.2 } }] } }]);
  assert.equal(scene.inspect().particles.systems[0].particles, 700);
  assert.ok(scene.topologyRevision > topologyBefore, 'the particle parts are new, so a renderer must replace its parts instead of updating them');
  assert.ok(scene.parts.some(part => part.name === 'spray0' && part.geometry.positions.length > 0));
});
