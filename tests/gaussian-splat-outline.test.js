import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { attachGaussianSplats, createGaussianSplats, createGaussianSplatsAsync, GAUSSIAN_SPLAT_SHADER_SOURCES } from '../src/gaussian-splats.js';
import { buildOutlineVertexSource, dilateSplatMask, OUTLINE_FRAGMENT_SOURCE, resolveSplatOutline } from '../src/splat-outline.js';

function resolve(outline, alphaCut = 0.5) {
  return resolveSplatOutline(outline, alphaCut, 'createGaussianSplats');
}

test('width 1 outlines the four neighbours of a block, not its diagonals', () => {
  const mask = ['.......', '.......', '..###..', '..###..', '..###..', '.......', '.......'];
  assert.deepEqual(dilateSplatMask(mask, 1), [
    '.......',
    '..ooo..',
    '.o###o.',
    '.o###o.',
    '.o###o.',
    '..ooo..',
    '.......',
  ]);
});

test('width 2 reaches two pixels out along the axes and one diagonal step, and is clipped at the image edge', () => {
  const mask = ['.....', '.....', '..#..', '.....', '.....'];
  assert.deepEqual(dilateSplatMask(mask, 2), [
    '..o..',
    '.ooo.',
    'oo#oo',
    '.ooo.',
    '..o..',
  ]);
  assert.deepEqual(dilateSplatMask(['#..'], 2), ['#oo']);
  assert.deepEqual(dilateSplatMask(['...', '...'], 1), ['...', '...']);
});

test('the outline needs alphaCut, whole pixels from 1 to 4, a real colour and says what to pass otherwise', () => {
  assert.equal(resolve(undefined, null), null);
  assert.equal(resolve(null, null), null);
  assert.deepEqual(resolve({}), { color: [0.04, 0.04, 0.06], width: 1 });
  assert.deepEqual(resolve({ color: '#fff', width: 4 }), { color: [1, 1, 1], width: 4 });
  assert.deepEqual(resolve({ color: [0, 0.5, 1], width: 2 }).color, [0, 0.5, 1]);
  assert.throws(() => resolve(3), /outline must be an object such as \{ color.*got number/);
  assert.throws(() => resolve([1]), /outline must be an object.*got an array/);
  assert.throws(() => resolve({ width: 0 }), /outline\.width must be a whole number of pixels from 1 to 4, got 0/);
  assert.throws(() => resolve({ width: 5 }), /outline\.width.*got 5/);
  assert.throws(() => resolve({ width: 1.5 }), /outline\.width.*got 1\.5/);
  assert.throws(() => resolve({ color: 'red' }), /outline\.color must be a hex colour.*"red"/);
  assert.throws(() => resolve({ color: [0, 2, 0] }), /outline\.color must be a hex colour/);
  assert.throws(() => resolve({ width: 1 }, null), /outline needs alphaCut/);
});

function oneSplat() {
  return {
    count: 1,
    positions: new Float32Array([0, 0, -3]),
    scales: new Float32Array([0.1, 0.1, 0.1]),
    rotations: new Float32Array([1, 0, 0, 0]),
    colors: new Uint8Array([200, 100, 50, 255]),
    bounds: { minimum: [-1, -1, -4], maximum: [1, 1, -2] },
  };
}

test('createGaussianSplats and its async twin validate the outline at the boundary', async () => {
  const data = oneSplat();
  assert.equal(createGaussianSplats(data, { alphaCut: 0.5 }).outline, null);
  assert.equal(createGaussianSplats(data, { alphaCut: 0.5, outline: { width: 2 } }).outline.width, 2);
  assert.throws(() => createGaussianSplats(data, { outline: { width: 1 } }), /createGaussianSplats outline needs alphaCut/);
  await assert.rejects(createGaussianSplatsAsync(data, { alphaCut: 0.5, outline: { width: 9 } }), /createGaussianSplatsAsync outline\.width/);
});

function createRecordingRenderer() {
  const calls = [];
  const context = new Proxy({}, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
      if (/^[A-Z_0-9]+$/.test(name)) return name;
      return (...parameters) => {
        calls.push([name, ...parameters]);
        return { created: name };
      };
    },
  });
  const renderer = {
    context,
    canvas: { width: 64, height: 64 },
    multisampleFramebuffer: {},
    projection: mat4.perspective(mat4.create(), 1, 1, 0.1, 50),
    view: mat4.create(),
    hdr: false,
    drawBlendBatches() {},
    dispose() {},
  };
  return { renderer, calls };
}

function drawWith(options) {
  const { renderer, calls } = createRecordingRenderer();
  attachGaussianSplats(renderer, createGaussianSplats(oneSplat(), options));
  calls.length = 0;
  renderer.drawBlendBatches({ eye: [0, 0, 0], exposure: 1 });
  return calls;
}

const shaderSources = calls => calls.filter(([name]) => name === 'shaderSource').map(call => String(call[2]));
const sha256 = text => createHash('sha256').update(text).digest('hex');

test('without an outline the shaders and draw calls are as before', () => {
  const plain = drawWith({ alphaCut: 0.5 });
  assert.ok(!shaderSources(plain).some(source => source.includes('outline')));
  assert.equal(plain.filter(([name]) => name === 'drawArraysInstanced').length, 1);
  assert.equal(sha256(GAUSSIAN_SPLAT_SHADER_SOURCES.opaqueFragment), 'd86baccbe36073ee22f6df8c9a2687bb6a9c1d2e9f3046b951139e5ae536cb61');
  assert.equal(sha256(GAUSSIAN_SPLAT_SHADER_SOURCES.vertex), 'c9557318769fb7d25c8f7b69089a23f0c95a4885fc1c23337d56dd4783ec75d8');
});

test('an outline scene draws the grown quads first, without depth write, then the fill', () => {
  const calls = drawWith({ alphaCut: 0.5, outline: { color: '#ff0000', width: 3 } });
  const sources = shaderSources(calls);
  assert.ok(sources.includes(OUTLINE_FRAGMENT_SOURCE));
  assert.ok(sources.includes(buildOutlineVertexSource(GAUSSIAN_SPLAT_SHADER_SOURCES.vertex)));
  assert.ok(!GAUSSIAN_SPLAT_SHADER_SOURCES.vertex.includes('outlineWidth'));
  assert.deepEqual(Array.from(calls.find(([name]) => name === 'uniform3fv')[2]), [1, 0, 0]);
  assert.ok(calls.some(([name, , value]) => name === 'uniform1f' && value === 3));
  const draws = calls.map(([name], index) => (name === 'drawArraysInstanced' ? index : -1)).filter(index => index >= 0);
  assert.equal(draws.length, 2);
  const depthMaskBefore = (start, end) => calls.slice(start, end).filter(([name]) => name === 'depthMask').map(call => call[1]).at(-1);
  assert.equal(depthMaskBefore(0, draws[0]), false);
  assert.equal(depthMaskBefore(draws[0], draws[1]), true);
});

test('the outline vertex shader refuses a vertex shader it cannot grow', () => {
  assert.throws(() => buildOutlineVertexSource('void main() {}'), /no longer contains/);
});

test('the outline fragment shader tests the distance to the disc edge against the width', () => {
  assert.match(OUTLINE_FRAGMENT_SOURCE, /dFdx\(inside\), dFdy\(inside\)/);
  assert.match(OUTLINE_FRAGMENT_SOURCE, /if \(-inside \/ gradient > outlineWidth\) discard;/);
});
