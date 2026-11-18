// Playing a grid sequence uploads one 3D texture per frame (#1045). The padded texel buffer is kept between frames of one resolution, so a sequence allocates it
// once, and each frame still lands in the texture exactly: its voxels inside a border of empty voxels, nothing left over from the frame before.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/fog-shader.js';
import { requireFeatureCode } from '../src/shader-registry.js';
import { GRID_BORDER_VOXELS, decodeVolumeGrid, encodeVolumeGrid, floatToHalf } from '../src/volume-grid.js';

const RESOLUTION = [3, 2, 2];
const VOXELS = RESOLUTION[0] * RESOLUTION[1] * RESOLUTION[2];

function gridOf(density, flame) {
  const channels = { density: new Float32Array(VOXELS).fill(density), flame: new Float32Array(VOXELS).fill(flame) };
  return decodeVolumeGrid(encodeVolumeGrid({ resolution: RESOLUTION, size: [1, 1, 1], channels }));
}

function recordingContext() {
  const calls = [];
  const names = ['TEXTURE_3D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'LINEAR', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'TEXTURE_WRAP_R', 'CLAMP_TO_EDGE', 'UNPACK_ALIGNMENT', 'RGBA', 'HALF_FLOAT', 'RGBA16F'];
  const context = Object.fromEntries(names.map((name, index) => [name, index + 1]));
  Object.assign(context, {
    createTexture: () => ({ id: calls.length }),
    deleteTexture() {},
    bindTexture() {},
    texParameteri() {},
    pixelStorei() {},
    texImage3D: (...args) => calls.push({ kind: 'texImage3D', texels: args[9] }),
    texSubImage3D: (...args) => calls.push({ kind: 'texSubImage3D', texels: args[10] }),
  });
  return { context, calls };
}

function texelAt(texels, padded, x, y, z) {
  const border = GRID_BORDER_VOXELS;
  return ((x + border) + padded[0] * ((y + border) + padded[1] * (z + border))) * 4;
}

test('a sequence keeps one texel buffer, and every frame fills the interior and leaves the border empty', () => {
  const { localGridTexture } = requireFeatureCode('volumeFog').support;
  const { context, calls } = recordingContext();
  const renderer = { context };
  const padded = RESOLUTION.map(count => count + 2 * GRID_BORDER_VOXELS);
  localGridTexture(renderer, gridOf(0.5, 2));
  localGridTexture(renderer, gridOf(0.25, 4));
  assert.deepEqual(calls.map(call => call.kind), ['texImage3D', 'texSubImage3D'], 'the second frame overwrites the first one\'s texture');
  assert.equal(calls[1].texels, calls[0].texels, 'the second frame reuses the first frame\'s texel buffer');
  const texels = calls[1].texels;
  assert.equal(texels[texelAt(texels, padded, 1, 1, 1)], floatToHalf(0.25));
  assert.equal(texels[texelAt(texels, padded, 1, 1, 1) + 2], floatToHalf(4));
  assert.equal(texels[texelAt(texels, padded, 0, 0, 0)], floatToHalf(0.25));
  let nonEmptyBorderTexels = 0;
  for (let z = 0; z < padded[2]; z++) {
    for (let y = 0; y < padded[1]; y++) {
      for (let x = 0; x < padded[0]; x++) {
        const interior = [x, y, z].every((value, axis) => value >= GRID_BORDER_VOXELS && value < GRID_BORDER_VOXELS + RESOLUTION[axis]);
        const offset = (x + padded[0] * (y + padded[1] * z)) * 4;
        if (!interior && texels.slice(offset, offset + 4).some(value => value !== 0)) nonEmptyBorderTexels++;
      }
    }
  }
  assert.equal(nonEmptyBorderTexels, 0, 'the border of empty voxels stays empty');
});

test('the same frame twice uploads once', () => {
  const { localGridTexture } = requireFeatureCode('volumeFog').support;
  const { context, calls } = recordingContext();
  const renderer = { context };
  const grid = gridOf(0.5, 2);
  localGridTexture(renderer, grid);
  localGridTexture(renderer, grid);
  assert.equal(calls.length, 1);
});
