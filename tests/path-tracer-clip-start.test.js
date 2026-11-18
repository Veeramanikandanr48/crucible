// camera.clipStart (#1159): camera rays start that far along the view axis, as the clip start of Cycles does, so a wall between the eye and the clip start is not drawn.
// The CPU tracer is tested in Node and the WebGPU tracer on a real adapter in headless Chrome (it skips where there is none).
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { createCamera, describeIgnoredFeatures, renderBand } from '../src/path-tracer.js';
import { noteIgnoredClipStart } from '../src/path-tracer-realtime-options.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

function slab(centerZ, color) {
  const matrix = new Float32Array([8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0.05, 0, 0, 0, centerZ, 1]);
  return { name: `slab-${centerZ}`, geometry: box(0, 1), matrix, material: { color, emission: 1 } };
}

// Looks down -z at a green wall 0.5 m ahead with a red wall 3 m ahead behind it. Both glow, so each pixel reads the first wall it sees.
const PARTS = [slab(-0.5, [0, 1, 0]), slab(-3, [1, 0, 0])];
const CAMERA = { eye: [0, 0, 0], target: [0, 0, -1], fov: 40 };

function centerPixel(camera) {
  const view = createCamera(camera, 8, 8);
  const scene = buildTraceScene(PARTS, {});
  const { color } = renderBand(scene, view, { width: 8, height: 8, samples: 1, bounces: 0, seed: 1, threads: 1, noiseThreshold: 0, minSamples: 1 }, 0, 8, () => {});
  const pixel = (4 * 8 + 4) * 3;
  return [color[pixel], color[pixel + 1], color[pixel + 2]];
}

test('without clipStart the wall in front is drawn, with a clipStart past it the wall behind is', () => {
  const near = centerPixel(CAMERA);
  assert.ok(near[1] > near[0] * 10, `the green wall fills the frame: ${near}`);
  const clipped = centerPixel({ ...CAMERA, clipStart: 1 });
  assert.ok(clipped[0] > clipped[1] * 10, `the red wall shows past the clip start: ${clipped}`);
  const shortOfWall = centerPixel({ ...CAMERA, clipStart: 0.2 });
  assert.ok(shortOfWall[1] > shortOfWall[0] * 10, `a clip start short of the wall still draws it: ${shortOfWall}`);
});

test('a camera without clipStart keeps no field for it', () => {
  assert.equal(createCamera({ ...CAMERA, clipStart: 1 }, 8, 8).clipStart, 1);
  assert.equal(createCamera(CAMERA, 8, 8).clipStart, undefined);
});

test('clipStart must be a finite distance of 0 or more, and the error says what to pass', () => {
  for (const bad of [-1, Number.NaN, '1', 1e6]) assert.throws(() => createCamera({ ...CAMERA, clipStart: bad }, 8, 8), /clipStart must be a distance from 0 to 100000/);
});

test('the WebGL tracer is told that clipStart is ignored, the CPU, WebGPU and native kernel are not', () => {
  assert.match(describeIgnoredFeatures([], {}, 'gpu', { clipStart: 1 }).join(' '), /camera\.clipStart is ignored/);
  assert.doesNotMatch(describeIgnoredFeatures([], {}, 'cpu', { clipStart: 1, kernelMaterials: true }).join(' '), /clipStart/);
  for (const backend of ['cpu', 'webgpu']) assert.doesNotMatch(describeIgnoredFeatures([], {}, backend, { clipStart: 1 }).join(' '), /clipStart/);
  assert.doesNotMatch(describeIgnoredFeatures([], {}, 'gpu', {}).join(' '), /clipStart/);
});

// Runs in the page: the centre pixel of the same two walls on the WebGPU tracer, without and with a clip start.
async function webGpuCenterPixels() {
  const { box: makeBox } = await import('/src/geometry.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const slabOf = (centerZ, color) => ({ name: `slab-${centerZ}`, geometry: makeBox(0, 1), matrix: new Float32Array([8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0.05, 0, 0, 0, centerZ, 1]), material: { color, emission: 1 } });
  const parts = [slabOf(-0.5, [0, 1, 0]), slabOf(-3, [1, 0, 0])];
  const pixels = {};
  for (const clipStart of [0, 1]) {
    const image = await renderPathTracedImage({ parts, environment: {}, camera: { eye: [0, 0, 0], target: [0, 0, -1], fov: 40, ...(clipStart ? { clipStart } : {}) } }, { width: 16, height: 16, samples: 4, bounces: 1, seed: 1, backend: 'webgpu', denoiser: 'none', threads: 1 });
    const at = (8 * 16 + 8) * 3;
    pixels[clipStart] = [image.linear[at], image.linear[at + 1], image.linear[at + 2]];
    pixels.ignored = image.report.ignored;
  }
  return pixels;
}

test('on a WebGPU adapter a clipStart past the near wall shows the wall behind it', async context => {
  await withWebGpuPage(context, async page => {
    const pixels = await page.evaluate(webGpuCenterPixels);
    assert.ok(pixels[0][1] > pixels[0][0] * 10, `the green wall fills the frame: ${pixels[0]}`);
    assert.ok(pixels[1][0] > pixels[1][1] * 10, `the red wall shows past the clip start: ${pixels[1]}`);
    assert.doesNotMatch(pixels.ignored.join(' '), /clipStart/);
  });
});

test('a clipStart at or past the far plane is refused, one below it is accepted (#1351)', () => {
  assert.throws(() => createCamera({ ...CAMERA, far: 10, clipStart: 10 }, 8, 8), /clipStart 10 is at or past the far plane 10.*Pass a clipStart below far/);
  assert.throws(() => createCamera({ ...CAMERA, far: 10, clipStart: 50 }, 8, 8), /far plane 10/);
  assert.equal(createCamera({ ...CAMERA, far: 10, clipStart: 9.5 }, 8, 8).clipStart, 9.5);
  assert.equal(createCamera({ ...CAMERA, clipStart: 50 }, 8, 8).clipStart, 50);
});

test('the real-time tracers note a clipStart they ignore once, and say nothing without one (#1351)', () => {
  const notes = [];
  noteIgnoredClipStart(notes, createCamera(CAMERA, 8, 8));
  assert.deepEqual(notes, []);
  const clipped = createCamera({ ...CAMERA, clipStart: 1 }, 8, 8);
  noteIgnoredClipStart(notes, clipped);
  noteIgnoredClipStart(notes, clipped);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /camera\.clipStart is ignored by the real-time tracers/);
});
