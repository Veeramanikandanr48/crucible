// The shadow of a blurred grid volume (#1763): the surface shadow taps read the grid at their own time in the shutter, only in the 'gridMotion' program, and the WebGPU path tracer
// draws grid volumes itself since #1785, each march step read at its own shutter time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWebGpuLocalVolumes, buildLocalVolumeFunctions, webGpuVolumeFeatures } from '../src/path-tracer-webgpu-local-volumes.js';
import { gridMotionTimeFraction } from '../src/volume-grid.js';

const SHARP_SHADOW_TAP = 'float profile = localVolumeProfile(index, position + towardSun * (entry + (span.y - entry) * (float(tap) + 0.5) / taps), true);';

test('the surface shadow of a grid reads each tap at its own time in the shutter, and a frame with the shutter off keeps the taps it had', async () => {
  await import('../src/fog-shader.js');
  const { createPostFragment, createLocalVolumeCompositeFragment, GRID_MOTION_STEP } = await import('../src/post.js');
  for (const source of [createPostFragment(['local']), createPostFragment(['bloom', 'volume', 'local', 'finish']), createLocalVolumeCompositeFragment(false)]) {
    assert.ok(!source.includes('vec3 tapPosition'), 'a shutter-off program has no shifted shadow tap');
    if (source.includes('localVolumeSurfaceShadow')) assert.ok(source.includes(SHARP_SHADOW_TAP), 'its shadow taps are the sharp ones, byte for byte');
  }
  const shutterOn = createPostFragment(['local', GRID_MOTION_STEP]);
  assert.ok(!shutterOn.includes(SHARP_SHADOW_TAP), 'a shutter-on program does not keep the sharp tap');
  const shiftedTap = shutterOn.match(/vec3 tapPosition = position \+ towardSun[^\n]*\n\s*if \(isGrid\) tapPosition = localGridMotionPosition\(index, tapPosition, fract\(localVolumeJitter\(\) \+ float\(tap\) \* ([0-9.]+)\)\);\n\s*float profile = localVolumeProfile\(index, tapPosition, true\);/);
  assert.ok(shiftedTap, 'each grid tap moves back along the velocity before it reads the density');
  assert.equal(Number(shiftedTap[1]), gridMotionTimeFraction(0, 1), 'with the golden ratio spread the march uses');
});

// Before #1785 the WebGPU tracer refused grid volumes and left their motion blur to the CPU tracer; it now draws both, so this pins that it does.
test('the WebGPU tracer accepts a moving grid volume and its grid march reads each step at its own time in the shutter', () => {
  const movingGrid = { shape: 'grid', gridData: {}, motionShutter: 0.5 };
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: [movingGrid] }));
  assert.equal(webGpuVolumeFeatures([movingGrid]).hasGridVolume, true, 'the grid march is spliced into the kernel');
  const gridKernel = buildLocalVolumeFunctions({ hasGrid: true });
  assert.ok(gridKernel.includes('fn localGridMotionPoint(volume: i32, point: vec3<f32>, timeFraction: f32)'));
  assert.ok(gridKernel.includes('localGridSample(volume, localGridMotionPoint(volume, point, timeFraction))'), 'each grid sample moves along the velocity by its shutter time');
  assert.doesNotMatch(buildLocalVolumeFunctions(), /localGridMotionPoint/, 'a scene without a grid compiles no grid motion');
  assert.throws(() => assertWebGpuLocalVolumes({ localVolumes: [{ shape: 'mesh', part: { name: 'room' }, motionShutter: 0.5 }] }), /localVolumes\[0\] is a mesh volume that was not prepared for tracing/);
});
