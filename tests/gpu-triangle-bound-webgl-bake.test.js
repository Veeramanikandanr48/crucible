import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { gpuTriangleCapacity } from '../src/path-tracer-gpu-pack.js';
import { MAX_GPU_TRACE_TRIANGLES, MAX_TRACE_TRIANGLES } from '../src/path-tracer-scene.js';

// The WebGL2 light bake (backend 'gpu') bounds its scene by the context's MAX_TEXTURE_SIZE, as the WebGPU bake does (#1242).
// A fake WebGL2 context with a one-row data texture shows the bound reaches the bake and pairs with `traceTexelsOnGpu`.
const CUBE_TRIANGLES = 12;
const FAKE_MAX_TEXTURE_SIZE = 1;
const DEVICE_TRIANGLE_LIMIT = gpuTriangleCapacity({ maximumTextureSize: FAKE_MAX_TEXTURE_SIZE }, MAX_GPU_TRACE_TRIANGLES);
const KERNEL_REACHED = 'fake context: the scene was accepted and the kernel was requested';

assert.ok(DEVICE_TRIANGLE_LIMIT < MAX_TRACE_TRIANGLES);
assert.ok(DEVICE_TRIANGLE_LIMIT > 2 * CUBE_TRIANGLES);

const cubesUnderLimit = Math.floor(DEVICE_TRIANGLE_LIMIT / CUBE_TRIANGLES) - 1;
const cubesOverLimit = Math.floor(DEVICE_TRIANGLE_LIMIT / CUBE_TRIANGLES) + 2;

const fakeContext = {
  MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE',
  getParameter: (name) => (name === 'MAX_TEXTURE_SIZE' ? FAKE_MAX_TEXTURE_SIZE : 'fake renderer'),
  getExtension: () => ({}),
  createProgram: () => {
    throw new Error(KERNEL_REACHED);
  },
};
globalThis.OffscreenCanvas = class {
  getContext() {
    return fakeContext;
  }
};

const { bakeLightmapsAsync } = await import('../src/light-bake-gpu.js');

// Each cube has a geometry of its own: copies that share one are held once by the WebGL2 tracer (#2239), so they would not reach the bound.
function cubeParts(count, geometryOf = () => box(0, 1)) {
  return Array.from({ length: count }, (_, index) => ({
    name: `cube-${index}`,
    geometry: geometryOf(),
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 2, 0, 0, 1]),
    material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0 },
  }));
}

const lamp = { pointLights: [{ position: [0, 3, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };
const bakeOptions = { samples: 1, bounces: 1, texelsPerUnit: 1, maxResolution: 8, backend: 'gpu' };

test('the WebGL2 light bake refuses a scene past the context bound with its count', async () => {
  await assert.rejects(bakeLightmapsAsync(cubeParts(cubesOverLimit), lamp, bakeOptions), {
    name: 'RangeError',
    message: new RegExp(`^This GPU path trace takes at most ${DEVICE_TRIANGLE_LIMIT} triangles in total .*, got ${cubesOverLimit * CUBE_TRIANGLES}\\. Simplify or drop meshes`),
  });
});

test('the WebGL2 light bake takes a scene inside the context bound as far as the kernel', async () => {
  await assert.rejects(bakeLightmapsAsync(cubeParts(cubesUnderLimit), lamp, bakeOptions), { message: KERNEL_REACHED });
});

test('the WebGL2 light bake counts copies of one shared cube once, so they pass a bound their flattened triangles exceed', async () => {
  const sharedCube = box(0, 1);
  assert.ok(cubesOverLimit * CUBE_TRIANGLES > DEVICE_TRIANGLE_LIMIT);
  await assert.rejects(bakeLightmapsAsync(cubeParts(cubesOverLimit, () => sharedCube), lamp, bakeOptions), { message: KERNEL_REACHED });
});
