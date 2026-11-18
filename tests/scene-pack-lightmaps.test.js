import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { decodePack } from '../src/scene-pack-format.js';
import { partsWithImageData } from '../src/scene-pack-images.js';
import { compileRecipeToPack, countLightmapTexels, PACK_MAX_LIGHTMAP_TEXELS, validatePackRecipe } from '../src/scene-pack.js';

function bakedRoomRecipe() {
  return JSON.parse(readFileSync(new URL('./fixtures/pack-baked-room.recipe.json', import.meta.url), 'utf8'));
}

function lightmapOf(part) {
  return part.material.emissiveMap ?? part.material.lightMap;
}

test('a packed baked room carries the same lightmap texels as the recipe build, and the page needs no bake', async () => {
  await loadAllAgentSceneModules();
  const live = createAgentScene(bakedRoomRecipe());
  const packed = decodePack(await compileRecipeToPack(bakedRoomRecipe()));
  assert.equal(packed.parts.length, live.parts.length);
  assert.ok(countLightmapTexels(live.parts) > 0, 'the fixture bakes light');
  live.parts.forEach((part, index) => {
    const expected = lightmapOf(part);
    const stored = lightmapOf(packed.parts[index]);
    assert.ok(stored, `${part.name} keeps its lightmap`);
    assert.equal(stored.image.width, expected.image.width);
    assert.equal(stored.image.height, expected.image.height);
    assert.equal(stored.colorSpace, expected.colorSpace);
    assert.ok(stored.image.data instanceof Uint8ClampedArray, 'texels stay one byte per channel');
    assert.deepEqual(Buffer.from(stored.image.data), Buffer.from(expected.image.data), `${part.name} texels`);
    assert.equal(packed.parts[index].material.emission, part.material.emission, `${part.name} keeps the lightmap scale`);
    assert.deepEqual([...packed.parts[index].geometry.uvs], [...part.geometry.uvs], `${part.name} keeps the lightmap UVs`);
  });
});

test('packing a baked recipe twice gives the same bytes', async () => {
  const first = await compileRecipeToPack(bakedRoomRecipe());
  const second = await compileRecipeToPack(bakedRoomRecipe());
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});

test('a recipe without a bake packs no lightmap texels', async () => {
  const recipe = bakedRoomRecipe();
  delete recipe.bake;
  const packed = decodePack(await compileRecipeToPack(recipe));
  assert.equal(countLightmapTexels(packed.parts), 0);
});

test('a bake over the texel budget is refused with the field and what to lower', async () => {
  const baked = decodePack(await compileRecipeToPack(bakedRoomRecipe()));
  const texels = countLightmapTexels(baked.parts);
  assert.ok(texels < PACK_MAX_LIGHTMAP_TEXELS, 'the fixture fits the default budget');
  await assert.rejects(
    compileRecipeToPack(bakedRoomRecipe(), { maxLightmapTexels: texels - 1 }),
    error => error instanceof TypeError
      && error.message.startsWith('recipe.bake.texelsPerUnit:')
      && error.message.includes(`${texels} lightmap texels`)
      && /Lower bake\.texelsPerUnit/.test(error.message),
  );
  await assert.doesNotReject(compileRecipeToPack(bakedRoomRecipe(), { maxLightmapTexels: texels }));
  assert.doesNotThrow(() => validatePackRecipe(bakedRoomRecipe()), 'a bake no longer needs a refusal');
});

test('the <crucible-scene> runtime reaches no recipe bake and no agent scene compiler', async () => {
  const result = await build({ entryPoints: ['src/crucible-scene.js'], bundle: true, write: false, metafile: true, format: 'esm', splitting: true, outdir: 'out', logLevel: 'error' });
  const inputs = Object.keys(result.metafile.inputs);
  const forbidden = inputs.filter(path => /src\/(agent-scene(?!-capabilities)|agent-bake|agent-look|agent-apply|scene-pack\.js)/.test(path));
  assert.deepEqual(forbidden, []);
  // src/light-bake.js is there already for the probe code of the `reflections` shader module (probe-trace.js imports its
  // ray helpers). A lightmap is drawn by the renderer from stored bytes and must add no second way in.
  const lightBakeImporters = inputs.filter(path => result.metafile.inputs[path].imports.some(entry => entry.path === 'src/light-bake.js'));
  assert.deepEqual(lightBakeImporters, ['src/probe-trace.js']);
});

test('the runtime turns packed texel bytes into the ImageData a browser uploads, and leaves other parts alone', () => {
  class FakeImageData {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  }
  const lightmap = { image: { width: 2, height: 1, data: new Uint8ClampedArray(8) }, colorSpace: 'srgb' };
  const bareMaterial = { color: [1, 1, 1] };
  const parts = [{ name: 'lit', material: { color: [1, 1, 1], emissiveMap: lightmap } }, { name: 'bare', material: bareMaterial }];
  globalThis.ImageData = FakeImageData;
  try {
    const converted = partsWithImageData(parts);
    assert.ok(converted[0].material.emissiveMap.image instanceof FakeImageData);
    assert.equal(converted[0].material.emissiveMap.image.data, lightmap.image.data, 'the bytes are not copied');
    assert.equal(converted[0].material.emissiveMap.colorSpace, 'srgb');
    assert.equal(converted[1], parts[1], 'a part without textures is returned as it is');
    assert.ok(!(parts[0].material.emissiveMap.image instanceof FakeImageData), 'the input is not changed');
  } finally {
    delete globalThis.ImageData;
  }
  assert.equal(partsWithImageData(parts)[0].material.emissiveMap.image, lightmap.image, 'without ImageData (Node) the plain image stays');
});
