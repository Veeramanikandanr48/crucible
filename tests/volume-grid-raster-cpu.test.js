// A varying grid volume (#2010): the rasterizer and the CPU path tracer must let the same light through a static grid frame, region by region
// (the method of local-volume-noise.test.js: the ratio of the float frames with and without the volume, display curve undone, against a CPU frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { applyViewTransform } from '../src/view-transform.js';
import { decodeVolumeGrid, registerVolumeGrid } from '../src/volume-grid.js';

const GRID_VOLUME = { shape: 'grid', grid: 'explosion', center: [0, 1.5, 0], size: [3, 3, 3], density: 2, steps: 96 };
const REGION_TOLERANCE = 0.01;
const MEAN_TOLERANCE = 0.005;
const SIZE = 64;
const CPU_SIZE = 32;
const CAMERA = { eye: [0, 5, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
const FIXTURE = new Uint8Array(readFileSync(new URL('./fixtures/explosion-32.67vg', import.meta.url)));

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

// Draws the scene with and without the volume in the rasterizer and returns both frames as floats (RGBA, rows bottom to top).
async function rasterFrames(page) {
  const task = async ({ size, localVolume, camera, gridBytes }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    const { decodeVolumeGrid: decode, registerVolumeGrid: register } = await import('/src/volume-grid.js');
    await import('/src/fog-shader.js');
    register('explosion', decode(new Uint8Array(gridBytes)));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    // Without a CSS size the renderer draws the frame at the wrong scale; the #2010 report measured that, not the volume.
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.body.append(canvas);
    const material = { tag: 'unlit', color: [1, 1, 1], metallic: 0, roughness: 1, emission: 0 };
    const ground = { name: 'ground', geometry: box(0, 1), matrix: new Float32Array([40, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 40, 0, 0, -0.1, 0, 1]), material };
    const renderer = new CrucibleRenderer(canvas, [ground], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const draw = localVolumes => {
      const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes };
      renderer.render({ ...camera, time: 0, environment, outputFramebuffer: output.framebuffer });
      return Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    };
    const frames = { plain: draw([]), filled: draw([localVolume]) };
    frames.glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return frames;
  };
  return page.evaluate(task, { size: SIZE, localVolume: GRID_VOLUME, camera: CAMERA, gridBytes: Array.from(FIXTURE) });
}

// The display shows aces(light) ^ (1 / 2.2); this undoes both for a channel, so the ratio of two frames is the light that got through.
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

function rasterTransmittance({ plain, filled }) {
  const result = new Float64Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const at = ((SIZE - 1 - row) * SIZE + column) * 4;
      result[row * SIZE + column] = plain[at] > 0 ? lightOf(filled[at]) / lightOf(plain[at]) : 1;
    }
  }
  return result;
}

async function cpuTransmittance() {
  registerVolumeGrid('explosion', decodeVolumeGrid(FIXTURE));
  const material = { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] };
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const { linear } = await renderPathTracedImage(
    { parts: [{ name: 'ground', geometry, material }], environment: { localVolumes: [GRID_VOLUME] }, camera: { eye: CAMERA.eye, target: CAMERA.target, up: CAMERA.up, fov: CAMERA.fov } },
    { width: CPU_SIZE, height: CPU_SIZE, denoise: false, threads: 1, bounces: 1, samples: 4 },
  );
  const result = new Float64Array(CPU_SIZE * CPU_SIZE);
  for (let pixel = 0; pixel < result.length; pixel++) result[pixel] = linear[pixel * 3];
  return result;
}

function cellMean(values, size, column, row, cell) {
  const scale = size / SIZE;
  let total = 0;
  let count = 0;
  for (let y = Math.floor(row * cell * scale); y < Math.floor((row + 1) * cell * scale); y++) {
    for (let x = Math.floor(column * cell * scale); x < Math.floor((column + 1) * cell * scale); x++) {
      total += values[y * size + x];
      count++;
    }
  }
  return total / count;
}

const meanOf = values => values.reduce((total, value) => total + value, 0) / values.length;

test('the rasterizer and the CPU path tracer let the same light through a static grid volume', async context => {
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
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const frames = await rasterFrames(page);
    assert.equal(frames.glError, 0);
    const raster = rasterTransmittance(frames);
    const cpu = await cpuTransmittance();
    const cells = 8;
    const cellSize = SIZE / cells;
    const regions = [];
    for (let row = 0; row < cells; row++) {
      for (let column = 0; column < cells; column++) {
        const rasterMean = cellMean(raster, SIZE, column, row, cellSize);
        const cpuMean = cellMean(cpu, CPU_SIZE, column, row, cellSize);
        regions.push({ column, row, raster: +rasterMean.toFixed(4), cpu: +cpuMean.toFixed(4), difference: +Math.abs(rasterMean - cpuMean).toFixed(4) });
      }
    }
    const rasterMean = meanOf(Array.from(raster));
    const cpuMean = meanOf(Array.from(cpu));
    const worst = regions.reduce((a, b) => (b.difference > a.difference ? b : a));
    assert.ok(Math.abs(rasterMean - cpuMean) < MEAN_TOLERANCE, `whole frame: raster ${rasterMean} against CPU ${cpuMean}`);
    assert.ok(worst.difference < REGION_TOLERANCE, `worst region ${JSON.stringify(worst)}`);
    const spread = Math.max(...regions.map(region => region.cpu)) - Math.min(...regions.map(region => region.cpu));
    assert.ok(spread > 0.3, `the grid must dim some regions more than others (spread ${spread})`);
  } finally {
    await browser?.close();
    server.kill();
  }
});
