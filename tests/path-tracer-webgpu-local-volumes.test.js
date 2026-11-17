// Local volumes on the WebGPU path tracer (#1048): the volume table is packed in plain JS and tested here, the kernel gets the march only for a
// scene that has volumes, boxes and spheres are drawn on a real adapter and compared to the CPU tracer (headless Chrome, skips without an adapter),
// the mesh kind the table cannot hold is refused with the backend that can draw it, and a grid volume (#1785) is packed after the table and marched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { buildTraceScene, refuseLocalVolumes } from '../src/path-tracer-scene.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { buildMegakernelSource, MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { assertWebGpuLocalVolumes, buildLocalVolumeFunctions, LOCAL_VOLUME_FUNCTIONS, LOCAL_VOLUME_GRID_HEADER_TEXELS, LOCAL_VOLUME_GRID_SHAPE, LOCAL_VOLUME_HEADER_TEXELS, LOCAL_VOLUME_TEXELS, packWebGpuLocalVolumes } from '../src/path-tracer-webgpu-local-volumes.js';
import { decodeVolumeGrid, encodeVolumeGrid, registerVolumeGrid } from '../src/volume-grid.js';
import { renderBlastBothBackends } from './helpers/grid-blast-render.js';
import { traceOnWebGpu } from '../src/path-tracer-webgpu.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

const SMOKE_BOX = { shape: 'box', center: [0, 1.5, 0], size: [3, 1.5, 3], density: 1.2, falloff: 0.3, absorption: [0.7, 0.8, 1], emission: [0.2, 0.1, 0], emissionStrength: 2, scatter: 0.8, noiseAmount: 0.5, noiseScale: 2, steps: 24 };
const PUFF = { shape: 'sphere', center: [1, 1, 0], radius: 0.6, density: 2, falloff: 0.5 };
const EMBER = { shape: 'sphere', center: [-1.2, 0.9, 0.5], radius: 0.5, density: 0.5, emission: [1, 0.4, 0.1], emissionStrength: 3, steps: 16 };

function floorPart() {
  const matrix = new Float32Array([8, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
  return { name: 'floor', geometry: box(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } };
}

const rounded = values => [...values].map(value => Math.round(value * 1e4) / 1e4);

test('the table holds the count, the sky light and eight vectors per volume in the order the kernel reads them', () => {
  const [smoke, puff] = resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes');
  const environment = { width: 2, height: 1, channels: 3, data: new Float32Array(6).fill(0.25), intensity: 2 };
  const table = packWebGpuLocalVolumes([smoke, puff], environment);
  assert.equal(table.length, (LOCAL_VOLUME_HEADER_TEXELS + 2 * LOCAL_VOLUME_TEXELS) * 4);
  assert.equal(table[0], 2);
  assert.ok(Math.abs(table[4] - 0.5) < 1e-6, `sky red ${table[4]}`);
  const first = LOCAL_VOLUME_HEADER_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(first, first + 4)), [0, 1.5, 0, 0]);
  assert.deepEqual(rounded(table.subarray(first + 4, first + 8)), [1.5, 0.75, 1.5, 0.3]);
  assert.ok(Math.abs(table[first + 8] - 0.84) < 1e-6 && table[first + 11] === 0.5, 'absorption times density, then the noise amount');
  assert.ok(Math.abs(table[first + 12] - 0.4) < 1e-6 && table[first + 15] === 2, 'emission times strength, then the noise scale');
  assert.deepEqual(rounded(table.subarray(first + 16, first + 20)), [24, 0.8, 0, 0]);
  assert.deepEqual([...table.subarray(first + 20, first + 32)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const second = first + LOCAL_VOLUME_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(second, second + 4)), [1, 1, 0, 1]);
  assert.deepEqual(rounded(table.subarray(second + 4, second + 8)), [0.6, 0.6, 0.6, 0.5]);
  assert.ok(table[second + 18] === 0 && Math.abs(table[second + 19] - 0.6) < 1e-6, 'anisotropy and the radius');
});

test('a rotated box packs its axes rows, and more volumes than the limit are refused', () => {
  const turn = Math.PI / 2;
  const rotated = { ...resolveLocalVolumes([SMOKE_BOX], 'volumes')[0], axes: [Math.cos(turn), 0, Math.sin(turn), 0, 1, 0, -Math.sin(turn), 0, Math.cos(turn)] };
  const table = packWebGpuLocalVolumes([rotated], null);
  const rows = LOCAL_VOLUME_HEADER_TEXELS * 4 + 20;
  assert.ok(Math.abs(table[rows + 2] - 1) < 1e-6 && Math.abs(table[rows + 8] + 1) < 1e-6);
  assert.throws(() => packWebGpuLocalVolumes(new Array(9).fill(rotated), null), /at most 8 local volumes, got 9/);
});

test('the march is compiled into the megakernel only for a scene that has local volumes, and fog keeps its single phase function', () => {
  assert.doesNotMatch(MEGAKERNEL_SOURCE, /crossLocalVolumes|localVolumeProfile/);
  const localSource = buildMegakernelSource({ hasLocalVolumes: true });
  assert.match(localSource, /fn crossLocalVolumes\(/);
  assert.match(localSource, /crossLocalVolumes\(depth, position,/);
  assert.equal(localSource.match(/fn henyeyGreensteinPhase\(/g).length, 1);
  assert.doesNotMatch(localSource, /scatterInFog/);
  const both = buildMegakernelSource({ hasLocalVolumes: true, hasVolume: true });
  assert.equal(both.match(/fn henyeyGreensteinPhase\(/g).length, 1);
  assert.match(both, /fn scatterInFog\(/);
});

test('a mesh volume is refused on the WebGPU tracer with the backend that draws it, and a grid volume is not', async () => {
  assert.throws(() => assertWebGpuLocalVolumes({ localVolumes: [{ shape: 'box' }, { shape: 'mesh', part: { name: 'room' } }] }), /localVolumes\[1\] is a mesh volume, which only backend "cpu" traces/);
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: [{ shape: 'grid', gridData: {} }] }));
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes') }));
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({}));
  const scene = buildTraceScene([floorPart()], { localVolumes: [SMOKE_BOX] });
  scene.localVolumes = [{ ...scene.localVolumes[0], shape: 'mesh', part: { name: 'room' } }];
  await assert.rejects(traceOnWebGpu(scene, {}, { width: 2, height: 2, samples: 1, bounces: 1 }, () => {}), /is a mesh volume, which only backend "cpu" traces/);
});

// A 2 x 2 x 1 grid with distinct values per voxel, bound as a volume with the options a test turns on.
function boundGrid(options = {}) {
  const resolution = [2, 2, 1];
  const velocity = options.shutter > 0 ? { velocityX: [0.5, 1, 1.5, 2], velocityY: [0, 0, 0, 0], velocityZ: [0, 0, 0, 0] } : {};
  const channels = { density: [0.25, 0.5, 0.75, 1], temperature: [0, 0, 2, 3], flame: [1, 0.5, 0.25, 0], ...velocity };
  registerVolumeGrid('webgpu-grid-1785', decodeVolumeGrid(encodeVolumeGrid({ resolution, channels, size: [2, 2, 2] })));
  const resolved = resolveLocalVolumes([{ shape: 'grid', grid: 'webgpu-grid-1785', center: [0, 1, 0], density: 2, emission: [1, 0.5, 0.25], emissionStrength: 4, steps: 24, scatter: options.scatter ?? 0, blackbodyIntensity: options.blackbodyIntensity ?? 0, temperatureScale: 1000 }], 'volumes');
  return bindLocalVolumeParts(resolved, [], { shutter: options.shutter ?? 0 })[0];
}

test('a grid volume packs its table row with the grid shape code, then a block of resolution, flags and voxels in the grid file order', () => {
  const table = packWebGpuLocalVolumes([boundGrid()], null);
  const row = LOCAL_VOLUME_HEADER_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(row, row + 4)), [0, 1, 0, LOCAL_VOLUME_GRID_SHAPE]);
  assert.deepEqual(rounded(table.subarray(row + 4, row + 7)), [1, 1, 1], 'half the size of the box');
  assert.equal(table[row + 16], 24, 'the step count of the grid');
  const block = (LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS) * 4;
  assert.equal(table.length, block + (LOCAL_VOLUME_GRID_HEADER_TEXELS + 4) * 4, 'one vector per voxel while blackbody and shutter are off');
  assert.deepEqual(rounded(table.subarray(block, block + 8)), [2, 2, 1, 0, 0, 0, 0, 1]);
  const voxels = block + LOCAL_VOLUME_GRID_HEADER_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(voxels, voxels + 16)), [0.25, 1, 0, 0, 0.5, 0.5, 0, 0, 0.75, 0.25, 0, 0, 1, 0, 0, 0], 'density then flame, x fastest');
});

test('a grid with a blackbody and a shutter packs the baked radiance and the unit velocity after each voxel, and the header says so', () => {
  const volume = boundGrid({ blackbodyIntensity: 0.3, shutter: 0.04 });
  const table = packWebGpuLocalVolumes([volume], null);
  const block = (LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS) * 4;
  assert.ok(Math.abs(table[block + 3] - 0.3 * 4) < 1e-6, 'blackbody weight is intensity times emission strength');
  assert.deepEqual(rounded(table.subarray(block + 4, block + 8)), [0.04, 1, 1, 3]);
  assert.equal(table.length, block + (LOCAL_VOLUME_GRID_HEADER_TEXELS + 4 * 3) * 4);
  const coldVoxel = block + LOCAL_VOLUME_GRID_HEADER_TEXELS * 4;
  const hotVoxel = coldVoxel + 2 * 3 * 4;
  assert.deepEqual([...table.subarray(coldVoxel + 4, coldVoxel + 7)], [0, 0, 0], 'a cold voxel has no baked radiance');
  assert.ok(table[hotVoxel + 4] > 0, 'the voxel at 2000 K glows');
  assert.deepEqual(rounded(table.subarray(hotVoxel + 8, hotVoxel + 11)), [0.75, 0, 0], 'unit velocity: 1.5 m/s over a 2 m box');
});

test('the grid march is compiled only for a scene that has a grid, and a scene without one gets the kernel it had before grids', () => {
  assert.equal(LOCAL_VOLUME_FUNCTIONS, buildLocalVolumeFunctions({ hasGrid: false }));
  const plain = buildMegakernelSource({ hasLocalVolumes: true });
  assert.doesNotMatch(plain, /crossLocalGrid|localGridSample|GridCell/);
  const withGrid = buildMegakernelSource({ hasLocalVolumes: true, hasGridVolume: true });
  assert.match(withGrid, /fn crossLocalGrid\(/);
  assert.match(withGrid, /emitted \+= crossLocalGrid\(volume, origin, entries\[volume\], exits\[volume\] - entries\[volume\], jitter\);/);
  assert.match(withGrid, /if \(localVolumeTexel\(volume, 0\)\.w < -0\.5\) \{ return localGridSample\(volume, point\)\.density; \}/);
  assert.match(withGrid, /const LOCAL_GRID_TIME_STEP: f32 = 0\.618034;/);
  assert.match(withGrid, /for \(var corner = 0; corner < 8; corner\+\+\)/, 'trilinear over eight corners');
  assert.match(withGrid, /let stepCount = localVolumeStepCount\(volume, span\);/, 'the grid step count is the volume rule, capped by LOCAL_VOLUME_MAXIMUM_STEPS');
  assert.match(withGrid, /const LOCAL_VOLUME_MAXIMUM_STEPS: f32 = \d+\.0;/);
});

// How closely two difference images point the same way: the Pearson correlation of their pixels.
function correlation(first, second) {
  const meanOf = values => values.reduce((total, value) => total + value, 0) / values.length;
  const firstMean = meanOf(first);
  const secondMean = meanOf(second);
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  first.forEach((value, index) => {
    covariance += (value - firstMean) * (second[index] - secondMean);
    firstVariance += (value - firstMean) ** 2;
    secondVariance += (second[index] - secondMean) ** 2;
  });
  return covariance / Math.sqrt(firstVariance * secondVariance);
}

test('the WebGL tracers still refuse every local volume, and the wavefront kernel refuses them before it asks for an adapter', async () => {
  const scene = buildTraceScene([floorPart()], { localVolumes: [SMOKE_BOX] });
  assert.throws(() => refuseLocalVolumes(scene, 'backend "gpu"'), /traced by the CPU path tracer only; backend "gpu" cannot draw them/);
  await assert.rejects(traceOnWebGpu(scene, {}, { kernel: 'wavefront' }, () => {}), /wavefront kernel does not trace volume fog, local volumes or subsurface/);
});

// Runs in the page: the same scene on the CPU and the WebGPU tracer, with the seconds each took.
async function renderBothBackends({ volumes, width, height, samples }) {
  const { box: makeBox } = await import('/src/geometry.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const matrix = new Float32Array([8, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
  const parts = [{ name: 'floor', geometry: makeBox(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } }];
  const map = { width: 4, height: 2, channels: 3, data: new Float32Array(24).fill(0.15), intensity: 1, rotation: 0 };
  const environment = { localVolumes: volumes, keyColor: [3, 3, 3], lightDirection: [1, 0.6, 0.3], map };
  const camera = { eye: [0, 2.2, 5], target: [0, 1, 0], fov: 45 };
  const result = {};
  for (const backend of ['cpu', 'webgpu']) {
    const started = performance.now();
    const image = await renderPathTracedImage({ parts, environment, camera }, { width, height, samples, bounces: 3, seed: 7, backend, denoiser: 'none', threads: 1 });
    result[backend] = { linear: Array.from(image.linear), seconds: (performance.now() - started) / 1000 };
  }
  return result;
}

test('on a WebGPU adapter box and sphere volumes match the CPU tracer', { timeout: 300000 }, async context => {
  await withWebGpuPage(context, async page => {
    const { cpu, webgpu } = await page.evaluate(renderBothBackends, { volumes: [SMOKE_BOX, PUFF, EMBER], width: 48, height: 30, samples: 32 });
    let difference = 0;
    let reference = 0;
    let lit = 0;
    cpu.linear.forEach((value, index) => {
      difference += Math.abs(value - webgpu.linear[index]);
      reference += value;
      if (value > 0.05) lit++;
    });
    assert.ok(lit > 200, `the volumes show in the frame: ${lit} lit values`);
    assert.ok(difference / reference < 0.05, `mean relative difference ${(difference / reference).toFixed(4)}`);
  }, { hardwareOnly: true });
});

test('on a WebGPU adapter the #1735 blast grid matches the CPU tracer, and its motion blur changes the frame as the CPU blur does', { timeout: 600000 }, async context => {
  await withWebGpuPage(context, async page => {
    const frame = { resolution: 32, width: 64, height: 40, samples: 48, volumeTime: 3 / 24 };
    const sharp = await page.evaluate(renderBlastBothBackends, { ...frame, volumeShutter: 0 });
    let difference = 0;
    let reference = 0;
    sharp.cpu.linear.forEach((value, index) => {
      difference += Math.abs(value - sharp.webgpu.linear[index]);
      reference += value;
    });
    assert.deepEqual(sharp.webgpu.ignored, []);
    assert.ok(reference / sharp.cpu.linear.length > 0.05, 'the blast shows in the frame');
    assert.ok(difference / reference < 0.05, `shutter off: mean relative difference ${(difference / reference).toFixed(4)}`);
    const blurred = await page.evaluate(renderBlastBothBackends, { ...frame, volumeShutter: 1 / 12 });
    const changeOf = backend => blurred[backend].linear.map((value, index) => value - sharp[backend].linear[index]);
    const cpuChange = changeOf('cpu');
    const webgpuChange = changeOf('webgpu');
    assert.ok(Math.max(...webgpuChange.map(Math.abs)) > 0.02, 'the shutter changes the WebGPU frame');
    const agreement = correlation(cpuChange, webgpuChange);
    assert.ok(agreement > 0.8, `the blur changes both frames the same way: correlation ${agreement.toFixed(3)}`);
  }, { hardwareOnly: true });
});
