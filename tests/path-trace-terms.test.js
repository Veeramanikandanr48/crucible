import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { describeIgnoredFeatures, renderPathTracedImage } from '../src/path-tracer.js';
import { pathTraceEnvironment } from '../src/path-trace-terms.js';

// A recipe's ambientIntensity reaches the path tracer as environment map strength, like the rasterizer's ambient term (issue #1833).
const FLOOR = [{
  name: 'floor',
  geometry: box(0, 1),
  matrix: new Float32Array([8, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 8, 0, 0, -0.05, 0, 1]),
  material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.5, 0.5, 0.5] },
}];
const CAMERA = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const OPTIONS = { width: 16, height: 16, samples: 16, bounces: 2, denoise: false, threads: 1 };
const RECIPE = { setup: 'studio', environmentIntensity: 0.4, keyIntensity: 0, fillIntensity: 0 };

async function meanLinear(recipeEnvironment) {
  const environment = pathTraceEnvironment(recipeEnvironment);
  const { linear } = await renderPathTracedImage({ parts: FLOOR, environment, camera: CAMERA }, OPTIONS);
  return Array.from(linear).reduce((total, value) => total + value, 0) / linear.length;
}

test('ambientIntensity multiplies the map strength the trace lights with', () => {
  const plain = pathTraceEnvironment(RECIPE);
  assert.equal(plain.map.intensity, 0.4);
  assert.equal(plain.cameraIntensity, undefined);
  assert.equal(pathTraceEnvironment({ ...RECIPE, ambientIntensity: 0.5 }).map.intensity, 0.2);
  assert.equal(pathTraceEnvironment({ ...RECIPE, ambientIntensity: 0 }).map.intensity, 0);
  assert.equal(pathTraceEnvironment({ ...RECIPE, ambientIntensity: 2 }).map.intensity, 0.8);
});

test('the map object is reused while the recipe holds, and a camera ray still sees the sky at its own strength', () => {
  const first = pathTraceEnvironment({ ...RECIPE, ambientIntensity: 0.5 });
  assert.equal(pathTraceEnvironment({ ...RECIPE, ambientIntensity: 0.5 }).map, first.map);
  assert.equal(first.cameraIntensity, 0.4, 'the view keeps the sky at the unscaled map strength');
  assert.equal(pathTraceEnvironment({ ...RECIPE, ambientIntensity: 0.5, cameraIntensity: 0.1 }).cameraIntensity, 0.1, 'a recipe cameraIntensity wins');
});

test('the traced light follows ambientIntensity: half gives half, 0 gives black', async () => {
  const full = await meanLinear(RECIPE);
  const half = await meanLinear({ ...RECIPE, ambientIntensity: 0.5 });
  assert.ok(full > 0.05, `the studio map lights the floor (mean ${full})`);
  assert.ok(Math.abs(half / full - 0.5) < 0.02, `half the ambient light gives half the traced light (${half} against ${full})`);
  assert.equal(await meanLinear({ ...RECIPE, ambientIntensity: 0 }), 0);
});

test('daylight and the sky colours leave the traced map alone, as they leave the rasterizer lit by a map alone', () => {
  const plain = pathTraceEnvironment(RECIPE);
  const changed = pathTraceEnvironment({ ...RECIPE, daylight: 0, skyTop: [1, 0, 0], skyBottom: [0, 0, 1] });
  assert.equal(changed.map, plain.map);
});

test('the render report names the rasterizer-only terms a recipe sets', () => {
  const notesFor = environment => describeIgnoredFeatures(FLOOR, pathTraceEnvironment({ ...RECIPE, ...environment }));
  assert.deepEqual(notesFor({}), []);
  assert.match(notesFor({ fillIntensity: 1 }).join('\n'), /fillIntensity is ignored/);
  assert.match(notesFor({ world: true }).join('\n'), /world: true is ignored/);
  assert.deepEqual(notesFor({ world: false }), []);
});
