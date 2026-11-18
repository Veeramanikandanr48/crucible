import assert from 'node:assert/strict';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';
import { buildCopyScene } from '../bench/instancing/copies-scene.mjs';
import { createCamera } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const cook = await cookModule();
const { buildNativeInputV2, findNativeAddon, traceNative } = cook ?? {};

// Pins the albedo output of the native "cycles" kernel to a value measured on a real GPU (#1911). The #1760 sweep ran every addon
// call on lavapipe with the default LLVM JIT and with GALLIVM_PERF=nopt, and only the albedo output of a few scenes differed
// between the two. Nothing else in the suite pins an albedo value, so the suite passed in both modes.
//
// Reference: NVIDIA GeForce RTX 3060 (Vulkan, driver ray query), Cook 0.2.0, three runs, bit-identical albedo sum 2489.3600443217438.
// The same scene on lavapipe (AMD EPYC 9V74, LLVM 21.1.8): 2466.6036 with the default JIT (-0.92 percent, wrong) and 2489.3600
// with GALLIVM_PERF=nopt (+0.00003 percent). The tolerance of 0.1 percent sits a factor of 9 under the JIT error and a factor of
// about 3000 above the gap between the GPU and the correct lavapipe mode.
const REFERENCE_ALBEDO_SUM = 2489.3600443217438;
const RELATIVE_TOLERANCE = 1e-3;

const COPIES = 200;
const WIDTH = 128;
const HEIGHT = 96;
const SAMPLES = 1024;

const addonSkip = !cookInstalled || !findNativeAddon() ? 'the native addon is not built' : false;

function sumValues(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function traceEmissiveCopies() {
  const { parts, environment } = buildCopyScene('emissive', COPIES);
  const camera = createCamera({ eye: [0, 0, 14], target: [0, 0, -3], fov: 50 }, WIDTH, HEIGHT);
  const scene = buildTraceScene(parts, environment, { instancing: true });
  const input = buildNativeInputV2(scene, camera, { width: WIDTH, height: HEIGHT, samples: SAMPLES, seed: 1 });
  return traceNative(input, { width: WIDTH, height: HEIGHT, samples: SAMPLES, kernel: 'cycles' });
}

cookTest('the albedo output of 200 instanced emissive copies matches the sum measured on a real GPU', { skip: addonSkip }, t => {
  let traced;
  try {
    traced = traceEmissiveCopies();
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
    throw error;
  }
  const albedoSum = sumValues(traced.albedo);
  const relativeError = Math.abs(albedoSum - REFERENCE_ALBEDO_SUM) / REFERENCE_ALBEDO_SUM;
  assert.ok(relativeError < RELATIVE_TOLERANCE,
    `albedo sum ${albedoSum} on ${traced.adapter} is ${(relativeError * 100).toFixed(3)} percent from the GPU reference ${REFERENCE_ALBEDO_SUM}`);
});
