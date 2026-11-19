import test from 'node:test';
import assert from 'node:assert/strict';
import { installRenderPasses } from '../src/render-passes.js';
import { packObjectMotion } from '../src/object-motion-blur.js';

// A context that accepts every call and reports every shader, program and framebuffer as fine.
const acceptingContext = new Proxy({}, {
  get(_target, name) {
    if (name === 'checkFramebufferStatus') return () => 'COMPLETE';
    if (name === 'FRAMEBUFFER_COMPLETE') return 'COMPLETE';
    if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
    if (/^[A-Z0-9_]+$/.test(String(name))) return String(name);
    return () => ({});
  },
});

function createPassRenderer() {
  const renderer = {
    context: acceptingContext,
    canvas: { width: 8, height: 8 },
    benchmark: false,
    program: {},
    viewProjection: new Float32Array(16),
    renderTargets: { record() {}, release() {} },
    requireFeatureNames() {},
    drawsInOpaqueLoop: () => true,
    batches: [],
  };
  return installRenderPasses(renderer);
}

test('the velocity pass names a previous camera without an eye or a malformed previous view projection', () => {
  const renderer = createPassRenderer();
  assert.throws(() => renderer.passSupport.prepare({ pass: 'velocity', previousCamera: { target: [0, 0, 0] } }), /previousCamera\.eye must be 3 finite numbers, got undefined/);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'velocity', previousCamera: { eye: [1, NaN, 3] } }), /previousCamera\.eye/);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'velocity', previousViewProjection: [1, 2, 3] }), /previousViewProjection must be 16 finite/);
  assert.throws(() => renderer.passSupport.prepare({ pass: 'velocity', previousViewProjection: new Float32Array(16).fill(NaN) }), /previousViewProjection/);
  assert.equal(renderer.passSupport.prepare({ pass: 'velocity', previousCamera: { eye: [1, 2, 5] } }), 12);
  assert.equal(renderer.passSupport.prepare({ pass: 'velocity', previousViewProjection: new Float32Array(16) }), 12);
});

test('the velocity pass names object motion whose matrices are not a Float32Array', () => {
  const renderer = createPassRenderer();
  assert.throws(() => renderer.passSupport.prepare({ pass: 'velocity', objectMotion: { matrices: [1, 0, 0, 1] } }), /objectMotion\.matrices must be a Float32Array/);
  assert.equal(renderer.passSupport.prepare({ pass: 'velocity', objectMotion: { matrices: new Float32Array(16) } }), 12);
});

test('packing object motion names a matrix set that did not come from sampleWorldMatrices', () => {
  const part = { name: 'hero', matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  const renderer = { batches: [{ parts: [part] }], drawsInOpaqueLoop: () => true };
  assert.throws(() => packObjectMotion(renderer, {}, new Map()), /current must be a Map from sampleWorldMatrices\(parts\), got object/);
  assert.throws(() => packObjectMotion(renderer, new Map(), [[1]]), /previous must be a Map from sampleWorldMatrices/);
  assert.equal(packObjectMotion(renderer, new Map(), new Map()).count, 1);
});
