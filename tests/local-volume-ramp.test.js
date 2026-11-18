// The emission ramp of a local volume (#1046): a blackbody curve or a short colour ramp read by the density or by a grid's temperature or flame channel.
// The pure tests check the blackbody against a published table, the field, the packing and the CPU path tracer; the browser test draws a graded
// sphere in the rasterizer (headless Chrome on SwiftShader, from the Vite dev server) and in the CPU path tracer and compares the light per region.
// It skips when Chrome cannot start. Set LOCAL_VOLUME_RAMP_ARTIFACTS to a folder to also write the numbers there.
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';
import { createAgentScene } from '../src/agent-scene.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { applyViewTransform } from '../src/view-transform.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes } from '../src/local-volumes.js';
import { LOCAL_VOLUME_RAMP_STOPS } from '../src/local-volume-ramp.js';
import { blackbodyChromaticity, blackbodyRampColor, bakeEmissionRamp, sampleBakedRamp } from '../src/local-volume-ramp-bake.js';
import { createLocalVolumeCrossing } from '../src/path-tracer-volume.js';
import { assertWebGpuLocalVolumes, webGpuVolumeFeatures } from '../src/path-tracer-webgpu-local-volumes.js';
import { encodeVolumeGrid, decodeVolumeGrid } from '../src/volume-grid.js';

// Mitchell Charity, "What color is a blackbody?", bbr_color.txt (version 2001-Jun-22), http://www.vendian.org/mncharity/dir3/blackbody/:
// the CIE 1931 2 degree rows, columns R G B (linear sRGB, normalised so the largest is 1, out of gamut channels clipped to 0).
const CHARITY_TABLE = [
  [1000, 1.0, 0.0337, 0.0],
  [1200, 1.0, 0.0846, 0.0],
  [1400, 1.0, 0.1341, 0.0],
  [1600, 1.0, 0.1806, 0.0],
  [1800, 1.0, 0.2235, 0.0],
  [2000, 1.0, 0.2647, 0.0033],
  [2200, 1.0, 0.3126, 0.0219],
  [2400, 1.0, 0.3589, 0.0454],
  [2600, 1.0, 0.4034, 0.0734],
  [2800, 1.0, 0.4461, 0.1054],
  [3000, 1.0, 0.4870, 0.1411],
];
const TABLE_TOLERANCE = 0.02;

test('the blackbody hue from 1000 K to 3000 K matches the Charity table within 2 percent of full scale per channel', () => {
  const colour = new Float64Array(3);
  for (const [kelvin, ...expected] of CHARITY_TABLE) {
    blackbodyChromaticity(kelvin, colour);
    expected.forEach((reference, channel) => {
      assert.ok(Math.abs(colour[channel] - reference) <= TABLE_TOLERANCE, `${kelvin} K channel ${channel}: ${colour[channel].toFixed(4)} against the table's ${reference}`);
    });
  }
});

test('a blackbody ramp is dimmer where it is cooler, by the fourth power of the temperature', () => {
  const hot = blackbodyRampColor(3000, 3000, new Float64Array(3));
  const cool = blackbodyRampColor(1500, 3000, new Float64Array(3));
  assert.equal(hot[0], 1);
  assert.ok(Math.abs(cool[0] - 0.5 ** 4) < 1e-12);
  assert.ok(cool[2] < cool[0] * 0.01, 'a 1500 K body is orange: almost no blue');
});

test('baking a blackbody ramp samples eight temperatures and applies the exposure; stops keep their own count', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, emissionRamp: { kelvin: [1000, 3000], exposure: 2 } }]);
  const baked = bakeEmissionRamp(volume.emissionRamp);
  assert.equal(baked.count, LOCAL_VOLUME_RAMP_STOPS);
  assert.ok(Math.abs(baked.colors[(LOCAL_VOLUME_RAMP_STOPS - 1) * 3] - 2) < 1e-12);
  const [stopped] = resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, emissionRamp: { stops: [[1, 0.2, 0], [1, 1, 1], [0, 0, 1]] } }]);
  const stopBake = bakeEmissionRamp(stopped.emissionRamp);
  assert.equal(stopBake.count, 3);
  const middle = sampleBakedRamp(stopBake, 0.25, new Float64Array(3));
  assert.deepEqual(Array.from(middle), [1, 0.6, 0.5]);
});

test('the baked 8 stop blackbody ramp stays within 2 percent of the exact curve between its stops', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, emissionRamp: { kelvin: [1000, 3000] } }]);
  const baked = bakeEmissionRamp(volume.emissionRamp);
  const exact = new Float64Array(3);
  const sampled = new Float64Array(3);
  for (let step = 0; step <= 40; step++) {
    const position = step / 40;
    blackbodyRampColor(1000 + 2000 * position, 3000, exact);
    sampleBakedRamp(baked, position, sampled);
    for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(sampled[channel] - exact[channel]) <= 0.02, `position ${position} channel ${channel}: ${sampled[channel]} against ${exact[channel]}`);
  }
});

test('emissionRamp fills its defaults, resolves to itself again and names the field in every error', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1], emissionRamp: { kelvin: [1000, 3000] } }]);
  assert.deepEqual(volume.emissionRamp, { source: 'density', range: [0, 1], exposure: 1, kelvin: [1000, 3000] });
  assert.deepEqual(resolveLocalVolumes([volume])[0], volume);
  const label = 'environment.localVolumes[0].emissionRamp';
  const sphere = ramp => resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, emissionRamp: ramp }], 'environment.localVolumes');
  assert.throws(() => sphere('hot'), new RegExp(`${label.replaceAll('.', '\\.').replaceAll('[', '\\[').replaceAll(']', '\\]')} must be an object`));
  assert.throws(() => sphere({ kelvin: [1000, 3000], colour: 1 }), /emissionRamp has no field "colour"; use source, range, exposure, kelvin, stops/);
  assert.throws(() => sphere({}), /exactly one of kelvin .* or stops/);
  assert.throws(() => sphere({ kelvin: [1000, 3000], stops: [[1, 1, 1], [0, 0, 0]] }), /exactly one of kelvin/);
  assert.throws(() => sphere({ kelvin: [3000, 1000] }), /emissionRamp\.kelvin must be \[cool, hot\] with cool below hot/);
  assert.throws(() => sphere({ kelvin: [100, 3000] }), /emissionRamp\.kelvin\[0\]/);
  assert.throws(() => sphere({ stops: [[1, 1, 1]] }), /emissionRamp\.stops must be a list of 2 to 8 colours/);
  assert.throws(() => sphere({ stops: Array.from({ length: 9 }, () => [1, 1, 1]) }), /2 to 8 colours/);
  assert.throws(() => sphere({ kelvin: [1000, 3000], exposure: -1 }), /emissionRamp\.exposure/);
  assert.throws(() => sphere({ kelvin: [1000, 3000], range: [1, 0] }), /emissionRamp\.range must be \[low, high\]/);
  assert.throws(() => sphere({ kelvin: [1000, 3000], source: 'smoke' }), /emissionRamp\.source must be one of density, temperature, flame/);
  assert.throws(() => sphere({ kelvin: [1000, 3000], source: 'temperature' }), /"temperature" is a channel of a grid volume/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'mesh', part: 'room', emissionRamp: { kelvin: [1000, 3000] } }]), /belongs to a box, a sphere or a grid/);
});

test('a volume without emissionRamp resolves with no ramp field and packs no ramp, so it draws as before', () => {
  const plain = { shape: 'sphere', center: [0, 1, 0], radius: 1, emission: [1, 0.5, 0.2], emissionStrength: 3 };
  const [resolved] = resolveLocalVolumes([plain]);
  assert.equal('emissionRamp' in resolved, false);
  const buffers = createLocalVolumeBuffers();
  packLocalVolumes([resolved], buffers);
  assert.ok(buffers.rampSetup.every(value => value === 0));
  assert.ok(buffers.rampColors.every(value => value === 0));
});

test('packing a ramp writes the source code, the stop count, the range and the colours times the strength', () => {
  const buffers = createLocalVolumeBuffers();
  const volumes = resolveLocalVolumes([
    { shape: 'sphere', center: [0, 0, 0], radius: 1 },
    { shape: 'sphere', center: [0, 0, 0], radius: 1, emissionStrength: 4, emissionRamp: { stops: [[1, 0.5, 0.25], [2, 2, 2]], range: [0.5, 2], exposure: 0.5 } },
  ]);
  packLocalVolumes(volumes, buffers);
  assert.deepEqual(Array.from(buffers.rampSetup.slice(4, 8)), [1, 2, 0.5, 2]);
  assert.deepEqual(Array.from(buffers.rampColors.slice(LOCAL_VOLUME_RAMP_STOPS * 4, LOCAL_VOLUME_RAMP_STOPS * 4 + 8)), [2, 1, 0.5, 0, 4, 4, 4, 0]);
  assert.deepEqual(Array.from(buffers.rampSetup.slice(0, 4)), [0, 0, 0, 0]);
});

// A ray straight through a volume, as the CPU path tracer marches it.
function crossAt(volume, origin, direction, length = 10) {
  const crossing = createLocalVolumeCrossing(resolveLocalVolumes([volume]), null);
  const throughput = new Float64Array([1, 1, 1]);
  const emitted = new Float64Array(3);
  crossing(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], length, 0.5, throughput, emitted);
  return Array.from(emitted);
}

const FIREBALL = { shape: 'sphere', center: [0, 0, 0], radius: 1, falloff: 1, absorption: [0, 0, 0], steps: 32, emissionRamp: { kelvin: [1000, 3000] } };

test('the CPU path tracer grades a sphere from a white core to an orange edge', () => {
  const core = crossAt(FIREBALL, [0, 0, 5], [0, 0, -1]);
  const edge = crossAt(FIREBALL, [0.85, 0, 5], [0, 0, -1]);
  assert.ok(core.every(value => value > 0) && edge[0] > 0 && edge[1] > 0, `core ${core}, edge ${edge}`);
  const coreBlueShare = core[2] / core[0];
  const edgeBlueShare = edge[2] / edge[0];
  assert.ok(coreBlueShare > 0.1, `core blue over red ${coreBlueShare}`);
  assert.ok(edgeBlueShare < coreBlueShare * 0.5, `edge blue over red ${edgeBlueShare} against core ${coreBlueShare}`);
  assert.ok(core[0] > edge[0] * 3, `core red ${core[0]} against edge red ${edge[0]}`);
});

test('the exposure scales the light and exposure 0 gives none', () => {
  const base = crossAt(FIREBALL, [0, 0, 5], [0, 0, -1]);
  const doubled = crossAt({ ...FIREBALL, emissionRamp: { kelvin: [1000, 3000], exposure: 2 } }, [0, 0, 5], [0, 0, -1]);
  base.forEach((value, channel) => assert.ok(Math.abs(doubled[channel] - 2 * value) < 1e-9));
  assert.deepEqual(crossAt({ ...FIREBALL, emissionRamp: { kelvin: [1000, 3000], exposure: 0 } }, [0, 0, 5], [0, 0, -1]), [0, 0, 0]);
});

test('the ramp adds to the constant emission and a volume without it emits exactly emission times strength times the profile length', () => {
  const plain = { shape: 'sphere', center: [0, 0, 0], radius: 1, falloff: 0, absorption: [0, 0, 0], emission: [0.2, 0.1, 0.05], emissionStrength: 2, steps: 16 };
  const emitted = crossAt(plain, [0, 0, 5], [0, 0, -1]);
  [0.2, 0.1, 0.05].forEach((channel, index) => assert.ok(Math.abs(emitted[index] - channel * 2 * 2) < 1e-9, `channel ${index}: ${emitted[index]}`));
  const withRamp = crossAt({ ...plain, emissionRamp: { stops: [[0, 0, 0], [1, 1, 1]] } }, [0, 0, 5], [0, 0, -1]);
  withRamp.forEach((value, index) => assert.ok(value > emitted[index] + 0.5));
});

function gridBytes(channels) {
  // 32 voxels a side, so the ramp to empty across the faces and the cubic temperature (#1752) stay within a few percent of the flame channel.
  const voxels = 32 * 32 * 32;
  return decodeVolumeGrid(encodeVolumeGrid({ resolution: [32, 32, 32], channels: Object.fromEntries(Object.entries(channels).map(([name, value]) => [name, new Float32Array(voxels).fill(value)])) }));
}

function gridVolume(grid, rampFields) {
  const [resolved] = resolveLocalVolumes([{ shape: 'grid', grid: 'ramp-test', center: [0, 0, 0], size: [2, 2, 2], density: 1, absorption: [0, 0, 0], emissionRamp: { stops: [[0, 0, 0], [1, 1, 1]], ...rampFields } }]);
  return { ...resolved, gridData: grid };
}

test('a grid volume reads its ramp from the channel named by source, and no light where that channel is 0', () => {
  const hot = gridVolume(gridBytes({ density: 0.5, temperature: 1, flame: 0 }), { source: 'temperature' });
  const cold = gridVolume(gridBytes({ density: 0.5, temperature: 0, flame: 1 }), { source: 'temperature' });
  const flame = gridVolume(gridBytes({ density: 0.5, temperature: 0, flame: 1 }), { source: 'flame' });
  const lightOf = volume => {
    const crossing = createLocalVolumeCrossing([volume], null);
    const throughput = new Float64Array([1, 1, 1]);
    const emitted = new Float64Array(3);
    crossing(0, 0, 5, 0, 0, -1, 10, 0.5, throughput, emitted);
    return Array.from(emitted);
  };
  assert.ok(lightOf(hot)[0] > 1, `a hot cell glows: ${lightOf(hot)}`);
  assert.deepEqual(lightOf(cold), [0, 0, 0]);
  const [flameLight, hotLight] = [lightOf(flame)[0], lightOf(hot)[0]];
  assert.ok(Math.abs(flameLight - hotLight) < 0.03 * flameLight, `the temperature ramp ${hotLight} matches the flame ramp ${flameLight} to the cubic filter`);
});

// ---- The rasterizer against the CPU path tracer ----

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', data => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

const SIZE = 64;
const CPU_SIZE = 32;
const CPU_SAMPLES = 8;
const CELL = 8;
const CAMERA = { eye: [0, 0, 6], target: [0, 0, 0], up: [0, 1, 0], fov: 40 };
const COMPARED_SPHERE = { shape: 'sphere', center: [0, 0, 0], radius: 1.6, falloff: 0.9, absorption: [0, 0, 0], steps: 32, emissionRamp: { kelvin: [1000, 3000], exposure: 0.6 } };

async function rasterFrames(page, volumeLists) {
  const task = async ({ size, lists, camera }) => {
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    await import('/src/fog-shader.js');
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.body.append(canvas);
    const renderer = new CrucibleRenderer(canvas, [], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const dark = [0, 0, 0];
    const frames = lists.map(localVolumes => {
      renderer.render({ ...camera, time: 0, environment: { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, skyTop: dark, skyBottom: dark, localVolumes }, outputFramebuffer: output.framebuffer });
      return Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    });
    const glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return { frames, glError };
  };
  return page.evaluate(task, { size: SIZE, lists: volumeLists, camera: CAMERA });
}

// The display shows aces(light) ^ (1 / 2.2); this undoes both for a channel.
function lightOf(displayed) {
  let low = 0;
  let high = 64;
  for (let round = 0; round < 40; round++) {
    const middle = (low + high) / 2;
    if (applyViewTransform('aces', [middle, middle, middle])[0] ** (1 / 2.2) < displayed) low = middle;
    else high = middle;
  }
  return low;
}

// The linear light of a raster frame, three values per pixel, top row first.
function rasterLight(frame) {
  const result = new Float64Array(SIZE * SIZE * 3);
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      for (let channel = 0; channel < 3; channel++) result[(row * SIZE + column) * 3 + channel] = lightOf(frame[((SIZE - 1 - row) * SIZE + column) * 4 + channel]);
    }
  }
  return result;
}

// A path trace needs one part; this black triangle sits far behind the sphere, out of the frame, and adds no light.
const FAR_TRIANGLE = { positions: new Float32Array([-1, -1, -50, 1, -1, -50, 0, 1, -50]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]), indices: new Uint32Array([0, 1, 2]) };
const BLACK_MATERIAL = { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 0 };

async function cpuLight(volumes) {
  const { linear } = await renderPathTracedImage(
    { parts: [{ name: 'far-plane', geometry: FAR_TRIANGLE, material: BLACK_MATERIAL }], environment: { localVolumes: volumes }, camera: CAMERA },
    { width: CPU_SIZE, height: CPU_SIZE, denoise: false, threads: 1, bounces: 1, samples: CPU_SAMPLES },
  );
  return linear;
}

// The mean over a square cell of an image of `size` pixels, the cell given in the units of a 64 pixel frame, for one channel.
function cellMean(values, size, column, row, channel) {
  const scale = size / SIZE;
  let total = 0;
  let count = 0;
  for (let y = Math.floor(row * CELL * scale); y < Math.floor((row + 1) * CELL * scale); y++) {
    for (let x = Math.floor(column * CELL * scale); x < Math.floor((column + 1) * CELL * scale); x++) {
      total += values[(y * size + x) * 3 + channel];
      count++;
    }
  }
  return total / count;
}

test('the rasterizer and the CPU path tracer draw the same graded fireball, and exposure 0 draws the plain scene', async context => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(context, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchChrome(chromium);
    } catch (error) {
      skipOrThrow(context, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    const switchedOff = { ...COMPARED_SPHERE, emissionRamp: { ...COMPARED_SPHERE.emissionRamp, exposure: 0 } };
    const { frames, glError } = await rasterFrames(page, [[COMPARED_SPHERE], [switchedOff], []]);
    assert.equal(glError, 0);
    const [graded, off, empty] = frames.map(rasterLight);
    assert.deepEqual(Array.from(off), Array.from(empty), 'a ramp at exposure 0 draws the scene with no volume');
    const added = graded.map((value, index) => value - empty[index]);
    const cpu = await cpuLight([COMPARED_SPHERE]);
    let squaredError = 0;
    let squaredMean = 0;
    let largestCell = 0;
    const rows = [];
    for (let row = 0; row < SIZE / CELL; row++) {
      for (let column = 0; column < SIZE / CELL; column++) {
        for (let channel = 0; channel < 3; channel++) {
          const raster = cellMean(added, SIZE, column, row, channel);
          const traced = cellMean(cpu, CPU_SIZE, column, row, channel);
          squaredError += (raster - traced) ** 2;
          squaredMean += traced ** 2;
          largestCell = Math.max(largestCell, Math.abs(raster - traced));
          rows.push({ column, row, channel, raster, traced });
        }
      }
    }
    const relativeRmse = Math.sqrt(squaredError / squaredMean);
    if (process.env.LOCAL_VOLUME_RAMP_ARTIFACTS) {
      mkdirSync(process.env.LOCAL_VOLUME_RAMP_ARTIFACTS, { recursive: true });
      writeFileSync(join(process.env.LOCAL_VOLUME_RAMP_ARTIFACTS, 'ramp-raster-vs-cpu.json'), JSON.stringify({ relativeRmse, largestCell, rows }, null, 1));
    }
    const centerCell = (SIZE / CELL / 2) | 0;
    assert.ok(cellMean(added, SIZE, centerCell, centerCell, 2) / cellMean(added, SIZE, centerCell, centerCell, 0) > 0.08, 'the core is whiter than the edge');
    assert.ok(relativeRmse < 0.03, `relative RMSE between the rasterizer and the path tracer ${relativeRmse}, largest cell ${largestCell}`);
  } finally {
    await browser?.close();
    server.kill();
  }
});

test('the WebGPU path tracer draws a ramp (#1785): it accepts it and compiles the ramp light in only for a scene that has one', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, emissionRamp: { kelvin: [1000, 3000] } }]);
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: [volume] }));
  assert.equal(webGpuVolumeFeatures([volume]).hasEmissionRamp, true);
  assert.equal(webGpuVolumeFeatures([{ ...volume, emissionRamp: undefined }]).hasEmissionRamp, false);
});

test('a scene recipe resolves emissionRamp through the on-demand module and an edit with a bad ramp throws at build time', () => {
  const recipe = environment => ({ format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'box', type: 'box', bevel: 0 }], materials: [{ id: 'finish', color: [0.6, 0.6, 0.6], emission: 0 }], nodes: [{ id: 'block', geometry: 'box', material: 'finish' }], camera: { eye: [4, 3, 5], target: [0, 0, 0] }, environment });
  const volume = { shape: 'sphere', center: [0, 1, 0], radius: 1, emissionRamp: { kelvin: [1000, 3000] } };
  const scene = createAgentScene(recipe({ localVolumes: [volume] }));
  assert.deepEqual(scene.exportRecipe().environment.localVolumes[0].emissionRamp, { source: 'density', range: [0, 1], exposure: 1, kelvin: [1000, 3000] });
  assert.throws(() => createAgentScene(recipe({ localVolumes: [{ ...volume, emissionRamp: { kelvin: [3000, 1000] } }] })), /localVolumes\[0\]\.emissionRamp\.kelvin must be \[cool, hot\]/);
});
