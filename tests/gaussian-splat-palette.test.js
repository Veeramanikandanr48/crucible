import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { attachGaussianSplats, createGaussianSplats, createGaussianSplatsAsync, GAUSSIAN_SPLAT_SHADER_SOURCES } from '../src/gaussian-splats.js';
import { buildBayerMatrix, buildPaletteFragmentSource, resolveSplatPalette, snapToSplatPalette } from '../src/splat-palette.js';

const BLACK_AND_WHITE = ['#000000', '#fff'];

function resolve(palette, dither, alphaCut = 0.5) {
  return resolveSplatPalette(palette, dither, alphaCut, 'createGaussianSplats');
}

function greyGrid(value, dither, size) {
  const palette = resolve(BLACK_AND_WHITE, dither);
  const rows = [];
  for (let pixelY = 0; pixelY < size; pixelY++) {
    let row = '';
    for (let pixelX = 0; pixelX < size; pixelX++) {
      row += snapToSplatPalette([value, value, value], pixelX, pixelY, palette)[0] === 1 ? 'W' : 'B';
    }
    rows.push(row);
  }
  return rows;
}

const countWhite = rows => rows.join('').split('W').length - 1;

test('the Bayer matrices hold each index once in the standard order', () => {
  assert.deepEqual(buildBayerMatrix(4), [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  assert.deepEqual([...buildBayerMatrix(8)].sort((first, second) => first - second), Array.from({ length: 64 }, (_, index) => index));
});

test('without dither each colour snaps to the nearest palette colour, first on a tie', () => {
  const palette = resolve(['#000000', '#ffffff', [1, 0, 0]]);
  assert.deepEqual(snapToSplatPalette([0.4, 0.4, 0.4], 0, 0, palette), [0, 0, 0]);
  assert.deepEqual(snapToSplatPalette([0.6, 0.6, 0.6], 7, 3, palette), [1, 1, 1]);
  assert.deepEqual(snapToSplatPalette([0.9, 0.1, 0.1], 2, 2, palette), [1, 0, 0]);
  assert.deepEqual(snapToSplatPalette([0.5, 0.5, 0.5], 0, 0, resolve(BLACK_AND_WHITE)), [0, 0, 0]);
  assert.deepEqual(greyGrid(0.5, 'none', 2), ['BB', 'BB']);
});

test('bayer4 turns mid grey into a checkerboard and a 0.4 grey into its two lightest cells', () => {
  assert.deepEqual(greyGrid(0.5, 'bayer4', 4), ['BWBW', 'WBWB', 'BWBW', 'WBWB']);
  assert.deepEqual(greyGrid(0.4, 'bayer4', 4), ['BBBB', 'BBWB', 'BBBB', 'WBBB']);
});

test('bayer8 splits mid grey into half white, and the grid repeats every 8 pixels', () => {
  const grid = greyGrid(0.5, 'bayer8', 16);
  assert.equal(countWhite(grid.slice(0, 8).map(row => row.slice(0, 8))), 32);
  assert.deepEqual(grid.slice(8).map(row => row.slice(8)), grid.slice(0, 8).map(row => row.slice(0, 8)));
});

test('the palette needs alphaCut, 2 to 256 colours, a real dither name and says what to pass otherwise', () => {
  assert.equal(resolveSplatPalette(undefined, undefined, null, 'createGaussianSplats'), null);
  assert.equal(resolveSplatPalette(null, 'none', 0.5, 'createGaussianSplats'), null);
  assert.throws(() => resolve(undefined, 'bayer4'), /dither needs a palette/);
  assert.throws(() => resolve(['#000000']), /palette must be an array of 2 to 256 colours.*got 1 colours/);
  assert.throws(() => resolve(new Array(257).fill('#000')), /2 to 256 colours.*got 257/);
  assert.throws(() => resolve('#000000'), /palette must be an array of 2 to 256 colours.*got string/);
  assert.throws(() => resolve(['#000000', 'red']), /palette\[1\] must be a hex colour.*"red"/);
  assert.throws(() => resolve(['#000000', [0, 1.5, 0]]), /palette\[1\] must be a hex colour.*\[0,1\.5,0\]/);
  assert.throws(() => resolve(['#000000', 7]), /palette\[1\] must be a hex colour.*got 7/);
  assert.throws(() => resolve(BLACK_AND_WHITE, 'floyd'), /dither must be one of 'none', 'bayer4', 'bayer8', got "floyd"/);
  assert.throws(() => resolve(BLACK_AND_WHITE, 'bayer4', null), /palette needs alphaCut/);
  assert.equal(resolve(['#abc', [0, 0.5, 1]], 'bayer8').count, 2);
  assert.deepEqual(Array.from(resolve(['#ff8000', '#000']).colors.subarray(0, 3)), [1, 128 / 255, 0].map(Math.fround));
});

function oneSplat() {
  return {
    count: 1,
    positions: new Float32Array([0, 0, -3]),
    scales: new Float32Array([0.1, 0.1, 0.1]),
    rotations: new Float32Array([1, 0, 0, 0]),
    colors: new Uint8Array([200, 100, 50, 255]),
    bounds: { minimum: [-1, -1, -4], maximum: [1, 1, -2] },
  };
}

test('createGaussianSplats and its async twin validate the palette at the boundary', async () => {
  const data = oneSplat();
  assert.equal(createGaussianSplats(data, { alphaCut: 0.5 }).palette, null);
  const splats = createGaussianSplats(data, { alphaCut: 0.5, palette: BLACK_AND_WHITE, dither: 'bayer4' });
  assert.equal(splats.palette.count, 2);
  assert.equal(splats.palette.dither, 'bayer4');
  assert.throws(() => createGaussianSplats(data, { palette: BLACK_AND_WHITE }), /createGaussianSplats palette needs alphaCut/);
  await assert.rejects(createGaussianSplatsAsync(data, { alphaCut: 0.5, palette: ['#000'] }), /createGaussianSplatsAsync palette must be an array of 2 to 256/);
});

function createRecordingRenderer() {
  const calls = [];
  const context = new Proxy({}, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
      if (/^[A-Z_0-9]+$/.test(name)) return name;
      return (...parameters) => {
        calls.push([name, ...parameters]);
        return { created: name };
      };
    },
  });
  const renderer = {
    context,
    canvas: { width: 64, height: 64 },
    multisampleFramebuffer: {},
    projection: mat4.perspective(mat4.create(), 1, 1, 0.1, 50),
    view: mat4.create(),
    hdr: false,
    drawBlendBatches() {},
    dispose() {},
  };
  return { renderer, calls };
}

function drawWith(options) {
  const { renderer, calls } = createRecordingRenderer();
  attachGaussianSplats(renderer, createGaussianSplats(oneSplat(), options));
  calls.length = 0;
  renderer.drawBlendBatches({ eye: [0, 0, 0], exposure: 1 });
  return calls;
}

test('without a palette the shaders and draw calls are as before', () => {
  const plain = drawWith({ alphaCut: 0.5 });
  assert.ok(!plain.some(([name]) => name === 'uniform3fv'));
  assert.ok(!plain.filter(([name]) => name === 'shaderSource').some(call => String(call[2]).includes('paletteColors')));
  const digest = createHash('sha256').update(GAUSSIAN_SPLAT_SHADER_SOURCES.opaqueFragment).digest('hex');
  assert.equal(digest, 'd86baccbe36073ee22f6df8c9a2687bb6a9c1d2e9f3046b951139e5ae536cb61');
});

test('a palette scene draws with the palette shader and uploads its colours', () => {
  const snapped = drawWith({ alphaCut: 0.5, palette: ['#000', '#fff', '#f00'], dither: 'bayer4' });
  const upload = snapped.find(([name]) => name === 'uniform3fv');
  assert.deepEqual(Array.from(upload[2]), [0, 0, 0, 1, 1, 1, 1, 0, 0]);
  const sources = snapped.filter(([name]) => name === 'shaderSource').map(call => call[2]);
  assert.ok(sources.includes(buildPaletteFragmentSource(3, 'bayer4')));
  assert.ok(buildPaletteFragmentSource(3, 'bayer4').includes(`int[16](${buildBayerMatrix(4).join(', ')})`));
  assert.ok(!buildPaletteFragmentSource(3, 'none').includes('BAYER'));
  assert.equal(snapped.filter(([name]) => name === 'drawArraysInstanced').length, 1);
});
