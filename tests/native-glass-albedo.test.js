import assert from 'node:assert/strict';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const { findNativeAddon } = (await cookModule()) ?? {};
const skipWithoutAddon = !cookInstalled || !findNativeAddon() ? 'the native addon is not built' : false;

// The albedo pass records the colour of the first surface a ray meets, also when that surface is glass (#1918). The glass
// scene of native-job-materials.test.js has four quads in one plane, so which quad wins a pixel is a tie that a real GPU and
// lavapipe break differently; here the glass hangs in front of the wall, so every pixel has one right answer.
const WIDTH = 24;
const HEIGHT = 16;
const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 16, bounces: 4, seed: 7, fireflyClamp: 20, noiseThreshold: 0 };
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };
const WALL_COLOUR = [0.2, 0.6, 0.9];
const GLASS_COLOUR = [1, 1, 1];

function quad(halfWidth) {
  return {
    positions: Float32Array.from([-halfWidth, -halfWidth, 0, halfWidth, -halfWidth, 0, halfWidth, halfWidth, 0, -halfWidth, halfWidth, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

const atDepth = z => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1];

function albedoAt(albedo, x, y) {
  const first = (y * WIDTH + x) * 3;
  return Array.from(albedo.slice(first, first + 3));
}

function assertColour(actual, expected, message) {
  actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) < 1e-3, `${message}: ${actual} is not ${expected}`));
}

cookTest('the albedo of a pixel behind a glass pane is the glass, and the wall beside it keeps its own colour', { skip: skipWithoutAddon }, async t => {
  const cook = await cookModule();
  const { buildNativeInput } = await cookModule('pack-input');
  const parts = [
    { name: 'wall', geometry: quad(3), matrix: atDepth(0), material: { color: WALL_COLOUR, roughness: 0.9 } },
    { name: 'glass', geometry: quad(0.8), matrix: atDepth(2), material: { color: GLASS_COLOUR, transmission: 0.9, ior: 1.45, roughness: 0.05 } },
  ];
  const trace = sceneParts => cook.traceNative(buildNativeInput(buildTraceScene(sceneParts, environment), camera, packOptions, pack), { width: WIDTH, height: HEIGHT, samples: 8, kernel: 'cycles' });
  let traced;
  let wallOnly;
  try {
    traced = trace(parts);
    wallOnly = trace(parts.slice(0, 1));
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
    throw error;
  }
  assertColour(albedoAt(traced.albedo, 11, 7), GLASS_COLOUR, 'pixel inside the glass');
  assertColour(albedoAt(traced.albedo, 12, 8), GLASS_COLOUR, 'pixel inside the glass');
  assertColour(albedoAt(traced.albedo, 7, 8), albedoAt(wallOnly.albedo, 7, 8), 'pixel on the wall beside the glass');
  assertColour(albedoAt(traced.albedo, 2, 8), [0, 0, 0], 'pixel past the wall');
});
