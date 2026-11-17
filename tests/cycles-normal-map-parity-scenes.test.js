import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadReferenceScene, serializeSceneDescription } from '../bench/cycles-parity/scene-bridge.mjs';
import { TEXTURE_SCENES } from '../bench/cycles-parity/texture-scenes.mjs';

function normalMappedMaterials(description) {
  return description.materials.filter((material) => material.normalMap);
}

test('the brick-graph reference scene exports a tangent-space normal map for Cycles and Cook to read', async () => {
  const { rawScene } = await loadReferenceScene('brick-graph');
  const description = JSON.parse(JSON.stringify(await serializeSceneDescription('brick-graph', rawScene)));
  const materials = normalMappedMaterials(description);
  assert.equal(materials.length, 1, 'the brick wall is the one normal-mapped material');
  assert.ok(description.images.length > 0, 'the normal map image is exported with the scene');
});

test('the brick-flat control carries no normal map', async () => {
  const { rawScene } = await loadReferenceScene('brick-flat');
  const description = await serializeSceneDescription('brick-flat', rawScene);
  assert.equal(normalMappedMaterials(description).length, 0);
});

for (const sceneId of ['normal-plane', 'normal-sphere']) {
  test(`${sceneId} exports a normal map and the flat control does not`, async () => {
    const mapped = await serializeSceneDescription(sceneId, TEXTURE_SCENES[sceneId]());
    assert.equal(normalMappedMaterials(mapped).length, 1);
    const flatId = `${sceneId}-flat`;
    const flat = await serializeSceneDescription(flatId, TEXTURE_SCENES[flatId]());
    assert.equal(normalMappedMaterials(flat).length, 0);
  });
}

test('the normal map parity runner exports brick-graph beside the normal-* scenes', () => {
  const runnerSource = readFileSync(new URL('../bench/cycles-parity/run-normal-map-parity.py', import.meta.url), 'utf8');
  assert.match(runnerSource, /DEFAULT_REFERENCE_SCENES = "brick-graph"/);
  assert.match(runnerSource, /export-scene\.mjs/);
});
