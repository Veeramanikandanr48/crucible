// Renders the #1816 sphere volume (empty frame, 1 octave, 4 octaves) through the rasterizer and writes the displayed RGBA floats and frame times, as input for linearize-display-floats.mjs and edge-width.py.
// Run from the repository root through gpu-lock:
//   bash ~/.agents/tools/gpu-lock.sh node bench/cycles-parity/capture-volume-edge.mjs --label after --output-folder artifacts/volume-edge [--width 960 --height 540]
// Writes <label>-empty.f32, <label>-1.f32, <label>-4.f32 (bottom row first) and <label>-timing.json.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { freePort } from '../../tests/helpers/free-port.js';

const SERVER_START_TIMEOUT_MS = 30000;
const TIMED_FRAMES = 12;
const OCTAVE_COUNTS = [1, 4];

function parseCommandLine() {
  const { values } = parseArgs({
    options: {
      label: { type: 'string' },
      'output-folder': { type: 'string' },
      width: { type: 'string', default: '960' },
      height: { type: 'string', default: '540' },
    },
  });
  if (!values.label || !values['output-folder']) {
    throw new Error('pass --label <name> and --output-folder <folder>');
  }
  return { label: values.label, outputFolder: values['output-folder'], width: Number(values.width), height: Number(values.height) };
}

async function startViteServer() {
  const port = await freePort();
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('vite did not report ready in time; run from the repository root')), SERVER_START_TIMEOUT_MS);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return { server, port };
}

async function launchBrowser() {
  const chromeArguments = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'];
  return chromium.launch({ headless: true, args: chromeArguments }).catch(() => chromium.launch({ headless: true, channel: 'chrome', args: chromeArguments }));
}

// Runs inside the page, so it cannot use anything declared outside of it.
async function renderFramesInPage({ width, height, octaveCounts, timedFrames }) {
  const { CrucibleRenderer } = await import('/src/renderer.js');
  const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
  await import('/src/fog-shader.js');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.append(canvas);
  const renderer = new CrucibleRenderer(canvas, [], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
  const output = createFloatOutput(renderer.context, width, height);
  const camera = { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 35, time: 0 };
  const draw = (localVolumes) => {
    renderer.render({ ...camera, environment: { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes }, outputFramebuffer: output.framebuffer });
    return readFloatPixels(renderer.context, output.framebuffer, width, height);
  };
  const baseVolume = { shape: 'sphere', center: [0, 0, 0], radius: 1, density: 7, falloff: 0.9, noiseAmount: 1, noiseScale: 2.2, steps: 32, absorption: [1, 1, 1], emission: [1, 0.45, 0.12], emissionStrength: 8 };
  const result = { frames: {}, timing: {} };
  result.frames.empty = Array.from(draw([]));
  for (const octaves of octaveCounts) {
    const volume = octaves > 1 ? { ...baseVolume, noiseOctaves: octaves } : baseVolume;
    const start = performance.now();
    const firstFrame = draw([volume]);
    result.timing[octaves] = { firstDrawMs: performance.now() - start };
    result.frames[octaves] = Array.from(firstFrame);
    const frameTimes = [];
    for (let round = 0; round < timedFrames; round++) {
      const begin = performance.now();
      draw([volume]);
      frameTimes.push(performance.now() - begin);
    }
    frameTimes.sort((first, second) => first - second);
    result.timing[octaves].medianFrameMs = frameTimes[Math.floor(frameTimes.length / 2)];
  }
  result.glError = renderer.context.getError();
  return result;
}

const { label, outputFolder, width, height } = parseCommandLine();
mkdirSync(outputFolder, { recursive: true });
const { server, port } = await startViteServer();
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(renderFramesInPage, { width, height, octaveCounts: OCTAVE_COUNTS, timedFrames: TIMED_FRAMES });
  for (const key of Object.keys(result.frames)) {
    writeFileSync(`${outputFolder}/${label}-${key}.f32`, Buffer.from(new Float32Array(result.frames[key]).buffer));
  }
  const summary = { timing: result.timing, glError: result.glError };
  writeFileSync(`${outputFolder}/${label}-timing.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
  server.kill();
}
