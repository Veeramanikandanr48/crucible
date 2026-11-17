import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { attachGaussianSplats, createGaussianSplats, createGaussianSplatsAsync, GAUSSIAN_SPLAT_SHADER_SOURCES, parseGaussianSplatPly, parseGaussianSplatPlyAsync } from '../src/gaussian-splats.js';

const PROPERTIES = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SQUARE_ROOT_HALF = Math.SQRT1_2;

function buildPly(splats) {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${splats.length}`, ...PROPERTIES.map(name => `property float ${name}`), 'end_header', ''].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const body = new Float32Array(splats.length * PROPERTIES.length);
  splats.forEach((values, index) => body.set(values, index * PROPERTIES.length));
  const file = new Uint8Array(headerBytes.length + body.byteLength);
  file.set(headerBytes, 0);
  file.set(new Uint8Array(body.buffer), headerBytes.length);
  return file.buffer;
}

const splatAt = (x, y, z, rotation = [1, 0, 0, 0]) => [x, y, z, 0, 0, 0, 2, Math.log(0.1), Math.log(0.2), Math.log(0.3), ...rotation];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function rotateVector([w, x, y, z], [vx, vy, vz]) {
  const crossX = y * vz - z * vy;
  const crossY = z * vx - x * vz;
  const crossZ = x * vy - y * vx;
  const doubledX = y * crossZ - z * crossY;
  const doubledY = z * crossX - x * crossZ;
  const doubledZ = x * crossY - y * crossX;
  return [vx + 2 * (w * crossX + doubledX), vy + 2 * (w * crossY + doubledY), vz + 2 * (w * crossZ + doubledZ)];
}

test('upAxis z puts a splat on +Z at +Y and turns its orientation with it', () => {
  const quarterTurnAboutZ = [SQUARE_ROOT_HALF, 0, 0, SQUARE_ROOT_HALF];
  const file = buildPly([splatAt(0, 0, 2, quarterTurnAboutZ), splatAt(1, 2, 3)]);
  const turned = parseGaussianSplatPly(file, { upAxis: 'z' });
  const original = parseGaussianSplatPly(file);
  assert.deepEqual(Array.from(turned.positions.subarray(0, 3)).map(value => Math.round(value * 1e5) / 1e5 + 0), [0, 2, 0]);
  assert.deepEqual(Array.from(turned.positions.subarray(3, 6)), [1, 3, -2]);
  // The file's +Z (its up) is the turned scene's +Y, so a turned splat's axes are the original axes turned the same way.
  for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const before = rotateVector(Array.from(original.rotations.subarray(0, 4)), axis);
    const after = rotateVector(Array.from(turned.rotations.subarray(0, 4)), axis);
    assert.deepEqual(after.map(value => Math.round(value * 1e5) / 1e5 + 0), [before[0], before[2], -before[1]].map(value => Math.round(value * 1e5) / 1e5 + 0));
  }
  assert.deepEqual(turned.bounds.minimum, [0, 2, -2]);
  assert.deepEqual(turned.bounds.maximum.map(value => value + 0), [1, 3, 0]);
  const unitLength = Math.hypot(...turned.rotations.subarray(0, 4));
  assert.ok(Math.abs(unitLength - 1) < 1e-6);
});

test('upAxis z gives the same result from the async parser and an identity splat becomes a quarter turn about x', async () => {
  const file = buildPly([splatAt(0, 0, 2)]);
  const asynchronous = await parseGaussianSplatPlyAsync(file, { upAxis: 'z' });
  const synchronous = parseGaussianSplatPly(file, { upAxis: 'z' });
  assert.deepEqual(Array.from(asynchronous.positions), Array.from(synchronous.positions));
  assert.deepEqual(Array.from(asynchronous.rotations), Array.from(synchronous.rotations));
  const [w, x, y, z] = asynchronous.rotations;
  assert.ok(Math.abs(w - SQUARE_ROOT_HALF) < 1e-6 && Math.abs(x + SQUARE_ROOT_HALF) < 1e-6 && y === 0 && z === 0);
});

test('upAxis y and no upAxis parse to identical buffers, and a bad upAxis says what to pass', async () => {
  const file = buildPly([splatAt(1, 2, 3, [0.5, 0.5, 0.5, 0.5]), splatAt(-4, 5, 6)]);
  const defaulted = parseGaussianSplatPly(file);
  const explicit = parseGaussianSplatPly(file, { upAxis: 'y' });
  for (const name of ['positions', 'colors', 'scales', 'rotations']) {
    assert.deepEqual(Buffer.from(explicit[name].buffer), Buffer.from(defaulted[name].buffer), name);
  }
  assert.deepEqual(explicit.bounds, defaulted.bounds);
  assert.throws(() => parseGaussianSplatPly(file, { upAxis: 'x' }), /upAxis must be 'y'.*or 'z'.*got x/);
  assert.throws(() => parseGaussianSplatPly(file, { upAxis: 'Z' }), /upAxis must be/);
  await assert.rejects(parseGaussianSplatPlyAsync(file, { upAxis: 2 }), /upAxis must be/);
});

test('the soft splat shaders are the same text as before alphaCut existed', () => {
  assert.equal(sha256(GAUSSIAN_SPLAT_SHADER_SOURCES.vertex), 'c9557318769fb7d25c8f7b69089a23f0c95a4885fc1c23337d56dd4783ec75d8');
  assert.equal(sha256(GAUSSIAN_SPLAT_SHADER_SOURCES.fragment), '52063be234f912e7a12a37c3d4591e3ed3ec9aa8f123c722eb535c47ec77c5f2');
  assert.match(GAUSSIAN_SPLAT_SHADER_SOURCES.opaqueFragment, /alpha < max\(alphaCut, 1\.0 \/ 255\.0\)\) discard;/);
  assert.match(GAUSSIAN_SPLAT_SHADER_SOURCES.opaqueFragment, /outputColor = vec4\(color, 1\.0\)/);
});

test('alphaCut accepts a number from 0 to 1 or nothing, and says what to pass otherwise', async () => {
  const data = parseGaussianSplatPly(buildPly([splatAt(0, 0, -3)]));
  assert.equal(createGaussianSplats(data).alphaCut, null);
  assert.equal(createGaussianSplats(data, { alphaCut: null }).alphaCut, null);
  assert.equal(createGaussianSplats(data, { alphaCut: 0 }).alphaCut, 0);
  assert.equal(createGaussianSplats(data, { alphaCut: 0.5 }).alphaCut, 0.5);
  assert.equal((await createGaussianSplatsAsync(data, { alphaCut: 1 })).alphaCut, 1);
  for (const bad of [-0.1, 1.5, NaN, '0.5', true]) {
    assert.throws(() => createGaussianSplats(data, { alphaCut: bad }), /alphaCut must be a number from 0 to 1/, String(bad));
  }
  await assert.rejects(createGaussianSplatsAsync(data, { alphaCut: 2 }), /alphaCut must be a number from 0 to 1/);
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

function drawOneFrame(alphaCut) {
  const { renderer, calls } = createRecordingRenderer();
  const data = parseGaussianSplatPly(buildPly([splatAt(0, 0, -3)]));
  attachGaussianSplats(renderer, createGaussianSplats(data, alphaCut === undefined ? {} : { alphaCut }));
  calls.length = 0;
  renderer.drawBlendBatches({ eye: [0, 0, 0], exposure: 1 });
  return calls;
}

test('a soft splat scene draws blended without depth write, as before', () => {
  const calls = drawOneFrame();
  const names = calls.map(([name]) => name);
  assert.ok(names.includes('enable') && calls.some(([name, mode]) => name === 'enable' && mode === 'BLEND'));
  assert.deepEqual(calls.filter(([name]) => name === 'depthMask').map(call => call[1]), [false, true]);
  assert.equal(names.filter(name => name === 'useProgram').length, 1);
  assert.equal(names.filter(name => name === 'drawArraysInstanced').length, 1);
});

test('an alphaCut scene draws opaque with depth write, no blending and the cut as a uniform', () => {
  const calls = drawOneFrame(0.5);
  const blendEnabled = calls.some(([name, mode]) => name === 'enable' && mode === 'BLEND');
  const blendDisabled = calls.some(([name, mode]) => name === 'disable' && mode === 'BLEND');
  assert.equal(blendEnabled, false);
  assert.equal(blendDisabled, true);
  assert.deepEqual(calls.filter(([name]) => name === 'depthMask').map(call => call[1]), [true, true]);
  assert.ok(calls.some(([name, , value]) => name === 'uniform1f' && value === 0.5), 'the cut reaches the shader');
  assert.equal(calls.filter(([name]) => name === 'drawArraysInstanced').length, 1);
  const fragmentSources = calls.filter(([name]) => name === 'shaderSource').map(call => call[2]);
  assert.ok(fragmentSources.some(source => source.includes('uniform float alphaCut;')));
});

test('soft and opaque scenes on one renderer draw the opaque one first, then the soft one with its own state', () => {
  const { renderer, calls } = createRecordingRenderer();
  const data = parseGaussianSplatPly(buildPly([splatAt(0, 0, -3)]));
  attachGaussianSplats(renderer, createGaussianSplats(data));
  attachGaussianSplats(renderer, createGaussianSplats(data, { alphaCut: 0.3 }));
  calls.length = 0;
  renderer.drawBlendBatches({ eye: [0, 0, 0], exposure: 1 });
  const stateChanges = calls.filter(([name, value]) => name === 'depthMask' || name === 'drawArraysInstanced' || (name === 'enable' && value === 'BLEND'));
  assert.deepEqual(stateChanges.map(([name, value]) => (name === 'depthMask' ? `depthMask:${value}` : name)), [
    'depthMask:true', 'drawArraysInstanced', 'depthMask:false', 'enable', 'drawArraysInstanced', 'depthMask:true',
  ]);
});
