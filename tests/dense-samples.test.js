// denseSamples lowers the MSAA sample count on scenes with more than one triangle per pixel (#1163), where the extra samples cost fragment work for little edge quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer, samplesForDensity, DENSE_TRIANGLES_PER_PIXEL } from '../src/renderer.js';
import { WebGL2GlazeBackend } from '../src/glaze-backend-webgl2.js';

function partWithTriangles(count) {
  return { geometry: { indices: new Uint32Array(count * 3) } };
}

const CANVAS = { clientWidth: 100, clientHeight: 100 };

test('a scene with more than one triangle per pixel uses denseSamples', () => {
  const pixels = 100 * 100 * 1 * 1;
  const parts = [partWithTriangles(pixels * DENSE_TRIANGLES_PER_PIXEL + 1)];
  assert.equal(samplesForDensity(parts, CANVAS, 1, 4, 2), 2);
});

test('a scene at or under one triangle per pixel keeps samples', () => {
  const pixels = 100 * 100;
  assert.equal(samplesForDensity([partWithTriangles(pixels)], CANVAS, 1, 4, 2), 4);
  assert.equal(samplesForDensity([partWithTriangles(10)], CANVAS, 1, 4, 2), 4);
});

test('the pixel ratio counts: the same triangles are sparse at twice the pixel ratio', () => {
  const parts = [partWithTriangles(100 * 100 * 2)];
  assert.equal(samplesForDensity(parts, CANVAS, 1, 4, 2), 2);
  assert.equal(samplesForDensity(parts, CANVAS, 2, 4, 2), 4);
});

test('denseSamples never raises the sample count', () => {
  const parts = [partWithTriangles(100 * 100 * 5)];
  assert.equal(samplesForDensity(parts, CANVAS, 1, 2, 4), 2);
});

test('denseSamples must be a positive integer', () => {
  for (const bad of [0, 1.5, -1, '2']) {
    assert.throws(() => samplesForDensity([], CANVAS, 1, 4, bad), /denseSamples must be a positive integer or null/);
  }
});

test('every part counts, so one geometry placed many times is as dense as many separate meshes (#1163)', () => {
  const shared = partWithTriangles(1000);
  const placements = Array.from({ length: 11 }, () => ({ geometry: shared.geometry }));
  assert.equal(samplesForDensity(placements, CANVAS, 1, 4, 2), 2);
  assert.equal(samplesForDensity(placements.slice(0, 9), CANVAS, 1, 4, 2), 4);
});

// A renderer without a GL context: only what resize() and chooseMultisampleSamples() read.
function resizingRenderer({ clientWidth, clientHeight, parts }) {
  const context = {
    RENDERBUFFER: 1, SAMPLES: 2, DEPTH_COMPONENT24: 3, RGBA8: 4, RGBA16F: 5, MAX_SAMPLES: 6, MAX_RENDERBUFFER_SIZE: 7, MAX_TEXTURE_SIZE: 8,
    isContextLost: () => false,
    getParameter: () => 8192,
    getInternalformatParameter: () => [4, 2, 1],
  };
  const canvas = { clientWidth, clientHeight, width: 0, height: 0 };
  const renderer = Object.create(CrucibleRenderer.prototype);
  const allocations = [];
  Object.assign(renderer, {
    context, backend: new WebGL2GlazeBackend(context), canvas, pixelRatio: 1, hdr: false, benchmark: false, shading: 'full', baseSamples: 4, denseSamples: 2, densityParts: parts, fitParts: [...parts, partWithTriangles(5000)], world: false,
    projection: new Float32Array(16), capabilities: { samples: 4 }, geometryBytes: 0, textureBytes: 0, depth: false, memoryBudgetMiB: 4096, maximumMemoryBudgetMiB: 4096,
    allocateFrameTargets(width, height) { allocations.push([width, height, this.multisampleSamples]); },
  });
  renderer.multisampleSamples = renderer.chooseMultisampleSamples(parts);
  return { renderer, canvas, allocations };
}

test('resizing a dense scene to a bigger canvas goes back to samples and reallocates the targets (#1163)', () => {
  const parts = [partWithTriangles(100 * 100 * 2)];
  const { renderer, canvas, allocations } = resizingRenderer({ clientWidth: 100, clientHeight: 100, parts });
  assert.equal(renderer.multisampleSamples, 2);
  canvas.clientWidth = 400;
  canvas.clientHeight = 400;
  renderer.resize();
  assert.equal(renderer.multisampleSamples, 4);
  assert.equal(renderer.capabilities.samples, 4);
  assert.equal(allocations.at(-1)[2], 4);
  canvas.clientWidth = 100;
  canvas.clientHeight = 100;
  renderer.resize();
  assert.equal(renderer.multisampleSamples, 2);
  assert.equal(allocations.at(-1)[2], 2);
});

test('a resize that keeps the sample count and the size allocates nothing, and without denseSamples the count never changes', () => {
  const parts = [partWithTriangles(100 * 100 * 2)];
  const dense = resizingRenderer({ clientWidth: 100, clientHeight: 100, parts });
  dense.renderer.resize();
  const first = dense.allocations.length;
  dense.renderer.resize();
  assert.equal(dense.allocations.length, first);
  const plain = resizingRenderer({ clientWidth: 100, clientHeight: 100, parts });
  plain.renderer.denseSamples = null;
  plain.renderer.multisampleSamples = plain.renderer.chooseMultisampleSamples(parts);
  plain.canvas.clientWidth = 400;
  plain.renderer.resize();
  assert.equal(plain.renderer.multisampleSamples, 4);
});

test('a resize with no size change keeps the count the constructor chose, whatever the fit list adds (the ground) (#1163)', () => {
  const parts = [partWithTriangles(100 * 100 - 100)];
  const { renderer, allocations } = resizingRenderer({ clientWidth: 100, clientHeight: 100, parts });
  assert.equal(renderer.multisampleSamples, 4);
  renderer.resize();
  assert.equal(renderer.multisampleSamples, 4);
  assert.ok(allocations.every(allocation => allocation[2] === 4));
});
