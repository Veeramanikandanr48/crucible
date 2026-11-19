import assert from 'node:assert/strict';
import test from 'node:test';

import { createFramebuffer, createPass } from '../src/path-tracer-realtime-gl.js';
import { createWebGpuDenoiser, createWebGpuRadianceCache } from '../src/path-tracer-realtime-webgpu-passes.js';

const usageFlags = { COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8, STORAGE: 16 };
globalThis.GPUBufferUsage = usageFlags;

// A device that counts buffers and fails the Nth allocation or the first bind group, so a setup that throws can be checked for leaks.
function createCountingDevice({ failBufferNumber = Infinity, failBindGroup = false } = {}) {
  const buffers = [];
  return {
    buffers,
    createBuffer(descriptor) {
      if (buffers.length + 1 === failBufferNumber) throw new RangeError('out of memory');
      const buffer = { ...descriptor, destroyed: 0, destroy() { this.destroyed++; } };
      buffers.push(buffer);
      return buffer;
    },
    createShaderModule: () => ({ async getCompilationInfo() { return { messages: [] }; } }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup() {
      if (failBindGroup) throw new Error('bind group refused');
      return {};
    },
    queue: { writeBuffer() {} },
  };
}

const leaked = device => device.buffers.filter(buffer => buffer.destroyed === 0).map(buffer => buffer.label);
const denoiserOptions = device => ({
  traceWidth: 8, traceHeight: 8, outputWidth: 16, outputHeight: 16, filterIterations: 2,
  tracedBuffers: [device.createBuffer({ label: 'traced 0', size: 16 }), device.createBuffer({ label: 'traced 1', size: 16 })],
  motionBuffer: device.createBuffer({ label: 'part motion', size: 16 }),
});

test('a denoiser whose buffer allocation fails midway destroys the buffers it already made', async () => {
  const device = createCountingDevice({ failBufferNumber: 3 + 6 });
  const options = denoiserOptions(device);
  await assert.rejects(() => createWebGpuDenoiser(device, options), /out of memory/);
  assert.deepEqual(leaked(device).filter(label => !['traced 0', 'traced 1', 'part motion'].includes(label)), []);
});

test('a denoiser whose bind group is refused destroys every buffer it made', async () => {
  const device = createCountingDevice();
  const options = denoiserOptions(device);
  device.createBindGroup = () => { throw new Error('bind group refused'); };
  await assert.rejects(() => createWebGpuDenoiser(device, options), /bind group refused/);
  assert.deepEqual(leaked(device).filter(label => !['traced 0', 'traced 1', 'part motion'].includes(label)), []);
});

test('a radiance cache whose second buffer fails destroys the first', async () => {
  const device = createCountingDevice({ failBufferNumber: 2 });
  await assert.rejects(() => createWebGpuRadianceCache(device), /out of memory/);
  assert.deepEqual(leaked(device), []);
});

function createCountingGl({ compileStatus = true, linkStatus = true, frameBufferStatus = true } = {}) {
  const live = new Set();
  const make = kind => () => {
    const handle = { kind };
    live.add(handle);
    return handle;
  };
  const remove = handle => live.delete(handle);
  return {
    live,
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, FRAMEBUFFER: 5, COLOR_ATTACHMENT0: 100, TEXTURE_2D: 6, NONE: 0, FRAMEBUFFER_COMPLETE: 7,
    createShader: make('shader'), deleteShader: remove, shaderSource() {}, compileShader() {}, getShaderParameter: () => compileStatus, getShaderInfoLog: () => 'bad shader',
    createProgram: make('program'), deleteProgram: remove, attachShader() {}, linkProgram() {}, getProgramParameter: () => linkStatus, getProgramInfoLog: () => 'bad link',
    createFramebuffer: make('framebuffer'), deleteFramebuffer: remove, bindFramebuffer() {}, framebufferTexture2D() {}, drawBuffers() {},
    checkFramebufferStatus: () => (frameBufferStatus ? 7 : 8),
  };
}

test('a pass whose fragment shader does not compile deletes its program and shaders', () => {
  const gl = createCountingGl();
  let compiled = 0;
  gl.getShaderParameter = () => ++compiled === 1;
  assert.throws(() => createPass(gl, 'broken'), /did not compile/);
  assert.equal(gl.live.size, 0);
});

test('a pass that does not link deletes its program and shaders', () => {
  const gl = createCountingGl({ linkStatus: false });
  assert.throws(() => createPass(gl, 'void main() {}'), /did not link/);
  assert.equal(gl.live.size, 0);
});

test('a framebuffer that is not complete is deleted', () => {
  const gl = createCountingGl({ frameBufferStatus: false });
  assert.throws(() => createFramebuffer(gl, [{ slot: 0, texture: {} }]), /cannot render to float targets/);
  assert.equal(gl.live.size, 0);
});

test('a framebuffer without attachments says so instead of failing on an array length', () => {
  const gl = createCountingGl();
  assert.throws(() => createFramebuffer(gl, []), /at least one attachment/);
  assert.equal(gl.live.size, 0);
});
