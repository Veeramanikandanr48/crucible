// camera.clipStart (#1159) on the native cycles kernel: createCamera sets the near word, so a wall between the eye and the clip
// start is not drawn. Skips without the Cook addon, like the other native tests.
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const { findNativeAddon, prepareCyclesInput, traceNative } = (await cookModule()) ?? {};
const { buildFlattenedJobNativeInput } = (await cookModule('job-input')) ?? {};

const skipWithoutAddon = !cookInstalled || findNativeAddon() === null ? 'the native addon is not built' : false;
const SIZE = 16;

function slab(centerZ, color) {
  const matrix = new Float32Array([8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0.05, 0, 0, 0, centerZ, 1]);
  return { name: `slab-${centerZ}`, geometry: box(0, 1), matrix, material: { color, emission: 1 } };
}

// A glowing green wall 0.5 m ahead with a glowing red wall 3 m ahead behind it: each pixel reads the first wall it sees.
const PARTS = [slab(-0.5, [0, 1, 0]), slab(-3, [1, 0, 0])];
const CAMERA = { eye: [0, 0, 0], target: [0, 0, -1], fov: 40 };

function centerPixel(clipStart) {
  const camera = createCamera({ ...CAMERA, ...(clipStart === undefined ? {} : { clipStart }) }, SIZE, SIZE);
  const scene = buildTraceScene(PARTS, {});
  const packOptions = { width: SIZE, height: SIZE, samples: 1, bounces: 0, seed: 1, fireflyClamp: 0, noiseThreshold: 0 };
  const input = buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
  const options = { width: SIZE, height: SIZE, samples: 1, maxSeconds: 120, kernel: 'cycles', noiseThreshold: 0 };
  const { rgba } = traceNative(prepareCyclesInput(input, options), options);
  const index = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  return [rgba[index], rgba[index + 1], rgba[index + 2]];
}

cookTest('a native trace with a clipStart past the near wall shows the wall behind it', { skip: skipWithoutAddon, timeout: 300000 }, () => {
  const unclipped = centerPixel(undefined);
  assert.ok(unclipped[1] > unclipped[0] * 10, `the green wall fills the frame: ${unclipped}`);
  const clipped = centerPixel(1);
  assert.ok(clipped[0] > clipped[1] * 10, `the red wall shows past the clip start: ${clipped}`);
  const shortOfWall = centerPixel(0.2);
  assert.ok(shortOfWall[1] > shortOfWall[0] * 10, `a clip start short of the wall still draws it: ${shortOfWall}`);
});
