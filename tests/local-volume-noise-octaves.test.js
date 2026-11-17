// noiseOctaves (#1725): an opt-in fractal sum for the noise of a local volume. A volume without the field keeps its bytes: the same resolved object, the same packed
// buffers and the same shader text as before the field existed. The rasterizer and the CPU path tracer read the same rule (tests/local-volume-noise.test.js compares them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes, localVolumeProfile, createLocalVolumeBuffers, packLocalVolumes, LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES } from '../src/local-volumes.js';
import { localVolumeNoise, localVolumeFractalNoise } from '../src/local-volume-noise.js';
import { createPostFragment, createLocalVolumeCompositeFragment, SHAPE_ONLY_STEP, NOISE_OCTAVES_STEP } from '../src/post.js';
import { assertWebGpuLocalVolumes } from '../src/path-tracer-webgpu-local-volumes.js';
import '../src/fog-shader.js';

const SPHERE = { shape: 'sphere', center: [0, 0, 0], radius: 1, falloff: 0.8, noiseAmount: 0.8, noiseScale: 2 };

test('noiseOctaves takes a whole number from 1 to 5 and names the range when it is outside', () => {
  assert.equal(LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES, 5);
  assert.equal(resolveLocalVolumes([{ ...SPHERE, noiseOctaves: 4 }])[0].noiseOctaves, 4);
  for (const bad of [0, 6, 1.5, '2', null, -1]) {
    assert.throws(() => resolveLocalVolumes([{ ...SPHERE, noiseOctaves: bad }], 'environment.localVolumes'), /environment\.localVolumes\[0\]\.noiseOctaves must be a whole number from 1 to 5/);
  }
});

test('a volume without the field, or with 1, resolves to the same object as before', () => {
  const plain = resolveLocalVolumes([SPHERE])[0];
  assert.deepEqual(resolveLocalVolumes([{ ...SPHERE, noiseOctaves: 1 }])[0], plain);
  assert.equal('noiseOctaves' in plain, false);
  assert.deepEqual(resolveLocalVolumes([resolveLocalVolumes([{ ...SPHERE, noiseOctaves: 3 }])[0]])[0], resolveLocalVolumes([{ ...SPHERE, noiseOctaves: 3 }])[0], 'a resolved volume resolves again');
});

test('a grid volume refuses octaves, since its detail comes from the grid', () => {
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', center: [0, 0, 0], grid: 'smoke', noiseOctaves: 3 }]), /noiseOctaves does not apply to a grid volume/);
});

test('one octave is the plain noise and several are a deterministic, different field', () => {
  for (const [x, y, z] of [[0.3, 1.7, -2.2], [5.5, 0.1, 9.9]]) {
    assert.equal(localVolumeFractalNoise(x, y, z, 1), localVolumeNoise(x, y, z));
    assert.equal(localVolumeFractalNoise(x, y, z, undefined), localVolumeNoise(x, y, z));
    const four = localVolumeFractalNoise(x, y, z, 4);
    assert.equal(four, localVolumeFractalNoise(x, y, z, 4));
    assert.notEqual(four, localVolumeNoise(x, y, z));
    assert.ok(four >= 0 && four <= 1);
  }
});

function edgeRoughness(octaves) {
  const [volume] = resolveLocalVolumes([{ ...SPHERE, ...(octaves > 1 ? { noiseOctaves: octaves } : {}) }]);
  let total = 0;
  let previous = null;
  for (let x = 0.5; x < 1; x += 0.004) {
    const profile = localVolumeProfile(volume, x, 0.2, 0.1);
    if (previous !== null) total += Math.abs(profile - previous);
    previous = profile;
  }
  return total;
}

test('more octaves put finer detail along the edge of a sphere', () => {
  assert.ok(edgeRoughness(4) > edgeRoughness(1) * 1.3, `${edgeRoughness(4)} against ${edgeRoughness(1)}`);
});

test('the profile of a volume without octaves is unchanged and with octaves is not', () => {
  const [plain] = resolveLocalVolumes([SPHERE]);
  const [fractal] = resolveLocalVolumes([{ ...SPHERE, noiseOctaves: 4 }]);
  const [explicit] = resolveLocalVolumes([{ ...SPHERE, noiseOctaves: 1 }]);
  const point = [0.6, 0.3, 0.2];
  assert.equal(localVolumeProfile(explicit, ...point), localVolumeProfile(plain, ...point));
  assert.notEqual(localVolumeProfile(fractal, ...point), localVolumeProfile(plain, ...point));
});

test('the count rides in the fourth component of the second axis row and leaves a volume without it at zero bytes', () => {
  const plainBuffers = packLocalVolumes(resolveLocalVolumes([SPHERE]), createLocalVolumeBuffers());
  assert.equal(plainBuffers.noiseOctaves, false);
  assert.equal(plainBuffers.axes[7], 0);
  const buffers = packLocalVolumes(resolveLocalVolumes([SPHERE, { ...SPHERE, noiseOctaves: 4 }]), createLocalVolumeBuffers());
  assert.equal(buffers.noiseOctaves, true);
  assert.equal(buffers.axes[7], 0);
  assert.equal(buffers.axes[3 * 4 + 7], 3);
});

test('a frame without octaves compiles the shader it had, and a frame with them adds only the fractal sum', () => {
  for (const steps of [['local'], ['local', SHAPE_ONLY_STEP]]) {
    const plain = createPostFragment(steps);
    const fractal = createPostFragment([...steps, NOISE_OCTAVES_STEP]);
    assert.doesNotMatch(plain, /FractalNoise|noiseOctaves/);
    assert.match(fractal, /float localVolumeFractalNoise\(vec3 position, int octaves\)/);
    assert.match(fractal, /localVolumeFractalNoise\(position \* localVolumeEmission\[index\]\.w, 1 \+ int\(localVolumeAxes\[index \* 3 \+ 1\]\.w \+ 0\.5\)\)/);
    // The octave variant also counts its march steps from the finest cell (#1855): drop that block and the longer loop bound too.
    const withoutOctaveSteps = fractal.replace(/  int octaves = 1 \+ int\([^\n]*\n  if \([^\n]*octaves > 1\) return [^\n]*\n/, '').replace('step < 96; step++', 'step < 32; step++');
    assert.equal(withoutOctaveSteps.replace(/\/\/ Fractal value noise[\s\S]*?\n}\n/, '').replace(/localVolumeFractalNoise\(position \* localVolumeEmission\[index\]\.w, [^\n]*?\)\) :/, 'localVolumeNoise(position * localVolumeEmission[index].w) :'), plain);
  }
  assert.equal(createLocalVolumeCompositeFragment(false, 'both', false), createLocalVolumeCompositeFragment(false, 'both'));
  assert.match(createLocalVolumeCompositeFragment(false, 'shape', true), /localVolumeFractalNoise/);
});

test('the WebGPU path tracer refuses octaves and names the backend that draws them', () => {
  const scene = { localVolumes: resolveLocalVolumes([{ ...SPHERE, noiseOctaves: 2 }]) };
  assert.throws(() => assertWebGpuLocalVolumes(scene), /localVolumes\[0\]\.noiseOctaves .*backend "cpu"/);
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: resolveLocalVolumes([SPHERE]) }));
});
