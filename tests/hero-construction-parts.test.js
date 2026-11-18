// The hero builds its renderer on stand-in textures, so the constructor uploads one-pixel images and the real textures go up in slices (#779).
// It runs in headless Chrome from the Vite dev server; it skips locally when Chrome cannot start and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withStandInTextures } from '../src/hero-lab/loop/construction-parts.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

const isPinned = part => Boolean(part.skin);
const fakeImage = () => ({ width: 1, height: 1 });

test('withStandInTextures replaces the maps of unpinned parts and leaves pinned parts and the real descriptors alone', () => {
  const realMap = { image: { width: 2048, height: 2048 }, colorSpace: 'srgb', minFilter: 9987 };
  const realNormal = { image: { width: 1024, height: 1024 }, colorSpace: 'linear' };
  const textured = { name: 'wall', geometry: {}, material: { tag: 'surface', map: realMap, normalMap: realNormal } };
  const second = { name: 'floor', geometry: {}, material: { tag: 'surface', map: realMap } };
  const plain = { name: 'pipe', geometry: {}, material: { tag: 'surface' } };
  const pinned = { name: 'crane', skin: {}, geometry: {}, material: { tag: 'surface', map: realMap } };
  const [standInWall, standInFloor, samePlain, samePinned] = withStandInTextures([textured, second, plain, pinned], isPinned, fakeImage);
  assert.notEqual(standInWall, textured);
  assert.equal(samePlain, plain);
  assert.equal(samePinned, pinned);
  assert.equal(standInWall.material.map.image.width, 1);
  assert.equal(standInWall.material.normalMap.image.width, 1);
  assert.equal(standInWall.material.map.colorSpace, 'srgb');
  assert.equal(standInWall.material.normalMap.colorSpace, 'linear');
  assert.equal(standInFloor.material.map, standInWall.material.map, 'one stand-in per real descriptor');
  assert.equal(realMap.image.width, 2048, 'the real descriptor is untouched');
  assert.equal(textured.material.map, realMap);
});

test('a renderer built on stand-in textures uploads no real texture in its constructor and draws the same pixels after the sliced uploads (#779)', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await page.evaluate(async () => {
      const { sphere } = await import('/src/geometry.js');
      const { CrucibleRenderer } = await import('/src/renderer.js');
      await import('/src/replace-textured-parts.js');
      const { withStandInTextures } = await import('/src/hero-lab/loop/construction-parts.js');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const painter = document.createElement('canvas');
      painter.width = 256;
      painter.height = 256;
      const paint = painter.getContext('2d');
      for (let row = 0; row < 256; row++) {
        paint.fillStyle = `rgb(${row}, ${255 - row}, ${(row * 37) % 256})`;
        paint.fillRect(row % 256, row, 256, 1);
      }
      const descriptor = { image: painter, colorSpace: 'srgb', minFilter: 9987 };
      const geometry = sphere(24, 12);
      const parts = [{ name: 'ball', geometry, matrix: identity, material: { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.6, emission: 0, map: descriptor } }];
      const frame = { eye: [0, 0, 3], target: [0, 0, 0], fov: 50, time: 0 };
      const build = async (constructionParts) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        document.body.append(canvas);
        const context = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
        const widths = [];
        const realTexImage2D = context.texImage2D.bind(context);
        context.texImage2D = (...args) => {
          if (args.length === 9 || args.length === 6) widths.push(args.length === 9 ? args[3] : args[5].width);
          return realTexImage2D(...args);
        };
        const renderer = new CrucibleRenderer(canvas, constructionParts, { samples: 1, pixelRatio: 1, deferProgramLink: true });
        const uploadedByConstructor = widths.filter(width => width >= 256).length;
        await renderer.programsReady();
        // What uploadTexturesInSlices does for the whole world, one descriptor at a time.
        renderer.createTexture(descriptor);
        renderer.replaceParts(parts, { retainedUnchanged: true });
        renderer.render(frame);
        const pixels = new Uint8Array(64 * 64 * 4);
        context.readPixels(0, 0, 64, 64, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return { uploadedByConstructor, pixels: Array.from(pixels) };
      };
      const direct = await build(parts);
      const standIn = await build(withStandInTextures(parts, () => false));
      let differing = 0;
      for (let index = 0; index < direct.pixels.length; index++) if (direct.pixels[index] !== standIn.pixels[index]) differing++;
      return { directUploads: direct.uploadedByConstructor, standInUploads: standIn.uploadedByConstructor, differing, drawn: direct.pixels.some(value => value !== 0) };
    });
    assert.equal(result.drawn, true, 'the scene draws something');
    assert.equal(result.directUploads, 1, 'the control uploads the real texture in its constructor');
    assert.equal(result.standInUploads, 0, 'the stand-in build uploads no real texture in its constructor');
    assert.equal(result.differing, 0, 'the sliced path draws the same bytes');
  });
});
