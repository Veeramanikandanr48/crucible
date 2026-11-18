import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';

function stillLife(chromeRoughness = 0.05, extraEnvironment = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'ball', type: 'sphere' }],
    materials: [
      { id: 'floor', color: [0.6, 0.6, 0.65], roughness: 0.9 },
      { id: 'chrome', color: [0.95, 0.95, 0.95], metallic: 1, roughness: chromeRoughness },
    ],
    nodes: [
      { id: 'ground', geometry: 'box', material: 'floor', translation: [0, -0.05, 0], scale: [6, 0.1, 6] },
      { id: 'ball', geometry: 'ball', material: 'chrome', translation: [0, 0.5, 0], scale: [0.5, 0.5, 0.5] },
    ],
    camera: { eye: [0, 1.2, 3], target: [0, 0.5, 0], fov: 50, near: 0.05, far: 20 },
    environment: extraEnvironment,
  };
}

test('a smooth metal part gets its own reflection probe without any field', () => {
  const scene = createAgentScene(stillLife());
  const reflections = scene.inspect().reflections;
  assert.equal(reflections.placed, 1);
  assert.equal(reflections.partsWithProbe, 1);
  const byName = new Map(scene.parts.map(part => [part.name, part]));
  assert.ok(byName.get('ball').material.environmentProbe);
  assert.equal(byName.get('ground').material.environmentProbe, undefined);
});

test('a scene with no reflective part reports nothing and keeps its parts untouched', () => {
  const rough = createAgentScene(stillLife(0.9));
  assert.equal(rough.inspect().reflections, undefined);
  assert.ok(rough.parts.every(part => part.material.environmentProbe === undefined));
});

test('environment.objectReflections false turns the probes off', () => {
  const scene = createAgentScene(stillLife(0.05, { objectReflections: false }));
  assert.equal(scene.inspect().reflections, undefined);
  assert.ok(scene.parts.every(part => part.material.environmentProbe === undefined));
  assert.throws(() => createAgentScene(stillLife(0.05, { objectReflections: 'no' })), /environment\.objectReflections: got "no"; expected true or false/);
});

test('an edit that changes nothing the probe sees keeps the traced probe', () => {
  const scene = createAgentScene(stillLife());
  const before = scene.parts.find(part => part.name === 'ball').material.environmentProbe;
  scene.apply([{ type: 'set-environment', environment: { objectReflections: true } }], { expectedRevision: scene.inspect().revision });
  assert.equal(scene.parts.find(part => part.name === 'ball').material.environmentProbe, before);
});

function plainMaterial(material) {
  const { environmentProbe, ...fields } = material;
  return fields;
}

test('the object reflection cache is kept for an unchanged stage and replaced when a part moves', async () => {
  const { stageObjectReflections } = await import('../src/agent-reflections.js');
  const scene = createAgentScene(stillLife());
  const recipe = scene.exportRecipe();
  const sourceParts = scene.parts.map(part => ({ name: part.name, geometry: part.geometry, material: plainMaterial(part.material), matrix: Float32Array.from(part.matrix) }));
  const worldMatrices = new Map(sourceParts.map(part => [part.name, part.matrix]));
  const graph = { getNode: name => ({ worldMatrix: worldMatrices.get(name) }) };
  const staged = { ...recipe, environment: { keyColor: [1, 1, 1], pointLights: [], spotLights: [], areaLights: [], ...recipe.environment } };
  const first = stageObjectReflections(null, staged, sourceParts, sourceParts, graph, null);
  assert.equal(stageObjectReflections(first, staged, sourceParts, sourceParts, graph, null), first);
  worldMatrices.get('ball')[13] += 1;
  const moved = stageObjectReflections(first, staged, sourceParts, sourceParts, graph, null);
  assert.notEqual(moved, first);
  assert.equal(stageObjectReflections(moved, staged, sourceParts, sourceParts, graph, null), moved);
});

test('the object reflection cache is replaced when only the physical sky changes', async () => {
  const { stageObjectReflections } = await import('../src/agent-reflections.js');
  const scene = createAgentScene(stillLife(0.05, { sky: { type: 'physical', sunElevation: 30 } }));
  const recipe = scene.exportRecipe();
  const sourceParts = scene.parts.map(part => ({ name: part.name, geometry: part.geometry, material: plainMaterial(part.material), matrix: Float32Array.from(part.matrix) }));
  const worldMatrices = new Map(sourceParts.map(part => [part.name, part.matrix]));
  const graph = { getNode: name => ({ worldMatrix: worldMatrices.get(name) }) };
  const withSky = sky => ({ ...recipe, environment: { keyColor: [1, 1, 1], pointLights: [], spotLights: [], areaLights: [], ...recipe.environment, sky } });
  const first = stageObjectReflections(null, withSky(recipe.environment.sky), sourceParts, sourceParts, graph, null);
  assert.equal(stageObjectReflections(first, withSky({ ...recipe.environment.sky }), sourceParts, sourceParts, graph, null), first);
  const withoutSunDisc = stageObjectReflections(first, withSky({ ...recipe.environment.sky, sunDisc: false }), sourceParts, sourceParts, graph, null);
  assert.notEqual(withoutSunDisc, first);
});

test('a metallic scene over the bake triangle limit applies and skips the automatic probes (#2202)', () => {
  const recipe = stillLife();
  recipe.geometries.push({ id: 'dense', type: 'sphere', segments: 400, rings: 300 });
  recipe.nodes.push({ id: 'dense', geometry: 'dense', material: 'floor', translation: [2, 0.5, 0], scale: [0.5, 0.5, 0.5] });
  const scene = createAgentScene(recipe);
  assert.equal(scene.inspect().reflections, undefined);
  assert.ok(scene.parts.every(part => part.material.environmentProbe === undefined));
  const revision = scene.inspect().revision;
  scene.apply([{ type: 'add-material', material: { id: 'iron', color: [0.04, 0.04, 0.05], roughness: 0.2, metallic: 0.6 } }], { expectedRevision: revision });
});
