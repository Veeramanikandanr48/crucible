// The exact glow of one march step (#1894): a dense uniform volume marched in few steps must give the analytic integral
// emission * (1 - exp(-k L)) / k, not the start-of-step sum that counts each step's light too bright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { createLocalVolumeCrossing } from '../src/path-tracer-volume.js';
import { stepIntegralWeight, STEP_INTEGRAL_GLSL, STEP_INTEGRAL_WGSL } from '../src/volume-step-integral.js';
import '../src/fog-shader.js';
import { createLocalVolumeCompositeFragment } from '../src/post.js';
import { buildLocalVolumeFunctions } from '../src/path-tracer-webgpu-local-volumes.js';

const DENSE_BOX = { shape: 'box', center: [0, 0, 0], size: [4, 4, 2], falloff: 0, density: 7, absorption: [1, 0.5, 0.2], emission: [1, 0.8, 0.6], emissionStrength: 1, steps: 8 };
const BOX_DEPTH = 2;

function crossBox(volume) {
  const crossing = createLocalVolumeCrossing(resolveLocalVolumes([volume], 'volumes'));
  const throughput = Float64Array.from([1, 1, 1]);
  const emitted = new Float64Array(3);
  crossing(0, 0, 5, 0, 0, -1, 1e9, 0.5, throughput, emitted);
  return { throughput: Array.from(throughput), emitted: Array.from(emitted) };
}

test('the step weight is the exact integral (1 - exp(-tau)) / tau and continuous through the series limit', () => {
  assert.equal(stepIntegralWeight(0), 1);
  for (const opticalDepth of [1e-6, 5e-4, 0.00099999, 0.001, 0.0010001, 0.1, 0.44, 3, 40]) {
    const exact = -Math.expm1(-opticalDepth) / opticalDepth;
    assert.ok(Math.abs(stepIntegralWeight(opticalDepth) - exact) < 1e-9, `tau ${opticalDepth}: ${stepIntegralWeight(opticalDepth)} against ${exact}`);
  }
});

test('a dense uniform box marched in 8 steps emits the analytic glow within 2 percent, and the dimming is untouched', () => {
  const { throughput, emitted } = crossBox(DENSE_BOX);
  for (let channel = 0; channel < 3; channel++) {
    const extinction = DENSE_BOX.absorption[channel] * DENSE_BOX.density;
    const analytic = DENSE_BOX.emission[channel] * (1 - Math.exp(-extinction * BOX_DEPTH)) / extinction;
    assert.ok(Math.abs(emitted[channel] / analytic - 1) < 0.02, `channel ${channel}: emitted ${emitted[channel]}, analytic ${analytic}`);
    assert.ok(Math.abs(throughput[channel] - Math.exp(-extinction * BOX_DEPTH)) < 1e-9);
  }
});

test('every march that adds glow uses the weight: the rasterizer and the WebGPU tracer carry the same function', () => {
  const fragment = createLocalVolumeCompositeFragment(false, 'both', false);
  assert.ok(fragment.includes(STEP_INTEGRAL_GLSL), 'the rasterizer defines volumeStepIntegral');
  assert.equal((fragment.match(/volumeStepIntegral\(/g) ?? []).length, 3, 'one definition, the shape march and the grid march');
  const wgsl = buildLocalVolumeFunctions({ hasGrid: true });
  assert.ok(wgsl.includes(STEP_INTEGRAL_WGSL));
  assert.equal((wgsl.match(/volumeStepIntegral\(/g) ?? []).length, 3, 'one definition, the shape march and the grid march');
});
