import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';

await loadAllAgentSceneModules();

function recipe(nodes, extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }, { id: 'speck', type: 'box', bevel: 0 }],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes,
    ...extra,
  };
}

function unsupportedWarnings(nodes, extra) {
  const inspection = createAgentScene(recipe(nodes, extra)).inspect();
  return (inspection.diagnostics ?? []).filter(entry => entry.kind === 'unsupported-part');
}

// The rock spans x -2..2, y -1..1, z -2..2; the building's base is at y = 1.
const rock = { id: 'rock', geometry: 'box', material: 'stone', scale: [4, 2, 4] };

function building(centreX, extra = {}) {
  return { id: 'building', geometry: 'box', material: 'stone', translation: [centreX, 2, 0], scale: [2, 2, 2], ...extra };
}

test('a building with half its footprint past the rock edge warns with about 50 percent unsupported', () => {
  const warnings = unsupportedWarnings([rock, building(2)]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].target, 'building');
  assert.equal(warnings[0].unsupportedShare, 0.5);
  assert.match(warnings[0].message, /building has 50 percent of its footprint with nothing under it/);
  assert.match(warnings[0].message, /rests on rock/);
  assert.deepEqual(warnings[0].nodes, ['building', 'rock']);
});

test('a building fully on the rock does not warn', () => {
  assert.deepEqual(unsupportedWarnings([rock, building(0)]), []);
});

test('a box on the lowest surface of the scene does not warn', () => {
  const stackedOnGround = [{ id: 'ground', geometry: 'box', material: 'stone', translation: [0, -0.05, 0], scale: [10, 0.1, 10] },
    { id: 'crate', geometry: 'box', material: 'stone', translation: [4.5, 0.5, 0], scale: [2, 1, 2] }];
  assert.deepEqual(unsupportedWarnings(stackedOnGround), []);
  assert.deepEqual(unsupportedWarnings([{ id: 'crate', geometry: 'box', material: 'stone', translation: [0, 0.5, 0] }]), []);
});

test('a roof wider than its walls, a part with nothing under it and a light do not warn', () => {
  const walls = [rock, { id: 'walls', geometry: 'box', material: 'stone', translation: [0, 2, 0], scale: [2, 2, 2] }];
  const roof = { id: 'roof', geometry: 'box', material: 'stone', translation: [0, 3.25, 0], scale: [3, 0.5, 3] };
  assert.deepEqual(unsupportedWarnings([...walls, roof]), []);
  const hovering = { id: 'drone', geometry: 'box', material: 'stone', translation: [0, 6, 0], scale: [1, 0.3, 1] };
  const lights = { environment: { pointLights: [{ position: [2.5, 2, 0], intensity: 1 }] } };
  assert.deepEqual(unsupportedWarnings([rock, hovering], lights), []);
});

test('an animated part and a particle emitter that hang off the edge do not warn', () => {
  const moving = unsupportedWarnings([rock, building(2)], { motion: { duration: 1, tracks: [{ kind: 'node', id: 'building', property: 'translation', keyframes: [{ time: 0, value: [2, 2, 0] }, { time: 1, value: [2, 3, 0] }] }] } });
  assert.deepEqual(moving, []);
  const emitter = { id: 'sparks', geometry: 'speck', material: 'stone', translation: [2, 1.5, 0], scale: [2, 1, 2] };
  const particles = { particles: { gravity: [0, 0, 0], systems: [{ node: 'sparks', seed: 2, count: 20, lifetime: 3, speed: 1, size: 0.05 }] } };
  assert.deepEqual(unsupportedWarnings([rock, emitter], particles), []);
  assert.equal(unsupportedWarnings([rock, { ...emitter, id: 'crate' }]).length, 1);
});
