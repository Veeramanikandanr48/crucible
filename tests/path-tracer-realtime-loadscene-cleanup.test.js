import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebGpuRealtimeTracer } from '../src/path-tracer-realtime-webgpu.js';
import { resolveRealtimeOptions } from '../src/path-tracer-realtime-options.js';

// A counting fake device: every buffer it hands out is tracked until it is destroyed, so a leak shows as a live buffer.
const usageFlags = { MAP_READ: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8, STORAGE: 16, RENDER_ATTACHMENT: 32, COMPUTE: 64 };
globalThis.GPUBufferUsage = usageFlags;
globalThis.GPUTextureUsage = usageFlags;
globalThis.GPUShaderStage = usageFlags;
globalThis.GPUMapMode = { READ: 1 };

const liveBuffers = new Set();
const failures = { bindGroupAfter: Infinity, bindGroupCalls: 0 };

function createFakeBuffer(descriptor) {
  const buffer = {
    ...descriptor,
    destroy() { liveBuffers.delete(buffer); },
    async mapAsync() {},
    getMappedRange() { return new ArrayBuffer(descriptor.size); },
  };
  liveBuffers.add(buffer);
  return buffer;
}

const fakePass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };

const fakeDevice = {
  limits: { maxStorageBufferBindingSize: 1 << 30 },
  addEventListener() {},
  createBuffer: createFakeBuffer,
  createShaderModule: () => ({ async getCompilationInfo() { return { messages: [] }; } }),
  createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
  createBindGroupLayout: () => ({}),
  createPipelineLayout: () => ({}),
  createBindGroup() {
    failures.bindGroupCalls++;
    if (failures.bindGroupCalls > failures.bindGroupAfter) throw new Error('bind group failed');
    return {};
  },
  createCommandEncoder: () => ({
    beginComputePass: () => fakePass,
    clearBuffer() {},
    copyBufferToTexture() {},
    copyBufferToBuffer() {},
    finish: () => ({}),
  }),
  queue: { writeBuffer() {}, submit() {}, onSubmittedWorkDone: async () => {} },
};

const fakeAdapter = {
  limits: { maxStorageBuffersPerShaderStage: 10, maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 },
  info: { vendor: 'fake', architecture: 'device' },
  requestDevice: async () => fakeDevice,
};
Object.defineProperty(globalThis.navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => fakeAdapter, getPreferredCanvasFormat: () => 'bgra8unorm' } });

const fakeCanvas = { getContext: () => ({ configure() {}, getCurrentTexture: () => ({}), unconfigure() {} }) };
const floor = {
  positions: new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const camera = { eye: [0, 1, 4], target: [0, 0, 0], fov: 50 };
const scene = { parts: [{ name: 'floor', geometry: floor, material: { color: [0.5, 0.5, 0.5] } }], environment: {}, camera };
const resolved = resolveRealtimeOptions({ backend: 'webgpu', width: 64, height: 32, canvas: fakeCanvas });

function resetFailures(bindGroupAfter = Infinity) {
  failures.bindGroupAfter = bindGroupAfter;
  failures.bindGroupCalls = 0;
}

test('a failed first scene setup leaves no buffer alive', async () => {
  liveBuffers.clear();
  resetFailures();
  const tracer = await createWebGpuRealtimeTracer(scene, resolved, fakeCanvas);
  const bindGroupsOfASetup = failures.bindGroupCalls;
  tracer.dispose();
  assert.equal(liveBuffers.size, 0);

  for (const failingCall of [bindGroupsOfASetup - 1, bindGroupsOfASetup]) {
    liveBuffers.clear();
    resetFailures(failingCall - 1);
    await assert.rejects(() => createWebGpuRealtimeTracer(scene, resolved, fakeCanvas), /bind group failed/);
    assert.equal(liveBuffers.size, 0, `bind group call ${failingCall} of ${bindGroupsOfASetup} leaked`);
  }
});

test('a failed scene update keeps the previous kernel working and frees the new upload', async () => {
  liveBuffers.clear();
  resetFailures();
  const tracer = await createWebGpuRealtimeTracer(scene, resolved, fakeCanvas);
  const liveBefore = new Set(liveBuffers);

  resetFailures(0);
  await assert.rejects(() => tracer.update({ parts: [{ ...scene.parts[0], geometry: { ...floor } }] }), /bind group failed/);
  assert.deepEqual([...liveBuffers], [...liveBefore], 'the previous buffers stay and the new upload is freed');

  resetFailures();
  assert.doesNotThrow(() => tracer.frame(camera));
  tracer.dispose();
  assert.equal(liveBuffers.size, 0);
});
