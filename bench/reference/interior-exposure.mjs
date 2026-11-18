// Draws one daylit room with the raster renderer and with the path tracer from the same recipe, and prints the mean luminance
// of each (issue #1334). The room is closed except for one window; the only light is the sun and a physical sky.
//   node bench/reference/interior-exposure.mjs <output directory> [--samples 48] [--sun-bounce 2] [--exposure 3.6]
//     [--environment-intensity 0.3] [--backend gpu|cpu] [--key-intensity 1] [--sealed] [--width 960] [--height 540] [--denoise]
// Run it through gpu-lock.sh. Files are <output directory>/raster.png and path-traced.png; build the MCP server first
// (`npm run build && node scripts/build-mcp.mjs`).
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ROOM_CAMERA, ROOM_GEOMETRIES, ROOM_MATERIALS, roomNodes } from './interior-room.mjs';

const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0] ?? 'artifacts/1334');

function numberAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? Number(argumentsGiven[index + 1]) : fallback;
}

const samples = numberAfter('--samples', 48);
const sunBounce = numberAfter('--sun-bounce', 2);
const exposure = numberAfter('--exposure', 3.6);
const environmentIntensity = numberAfter('--environment-intensity', 0.3);
const keyIntensity = numberAfter('--key-intensity', 1);
const backendIndex = argumentsGiven.indexOf('--backend');
const backend = backendIndex >= 0 ? argumentsGiven[backendIndex + 1] : 'gpu';
// --sealed fills the window with a wall, so no light can enter: the room has to come out black from both renderers.
const sealed = argumentsGiven.includes('--sealed');
// --no-lawn drops the large ground slab, which stretches the shadow map and shows whether the room's shadows depend on it.
const withoutLawn = argumentsGiven.includes('--no-lawn');
// --tight-shadow fits the sun's shadow map to the room instead of the default 130 m world view.
const tightShadow = argumentsGiven.includes('--tight-shadow');
// --raster-only skips the path tracer, for sweeps of the raster alone; --shadow-extent <metres> fits the sun's shadow view to that half width around the room.
const rasterOnly = argumentsGiven.includes('--raster-only');
const shadowExtent = numberAfter('--shadow-extent', 0);
const WIDTH = numberAfter('--width', 960);
const HEIGHT = numberAfter('--height', 540);
// --denoise runs the OIDN denoiser on the path traced frame (the default leaves it off so the mean is the raw estimate).
const denoise = argumentsGiven.includes('--denoise') ? 'oidn' : false;

const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: ROOM_GEOMETRIES,
  materials: ROOM_MATERIALS,
  nodes: roomNodes({ sealed, withoutLawn }),
  camera: ROOM_CAMERA,
  environment: {
    lightDirection: [0.3, 0.55, -0.8], keyIntensity, environmentIntensity, sunBounce,
    sky: { type: 'physical', sunElevation: 33, sunRotation: 20 },
    viewTransform: 'agx',
  },
  effects: { exposure },
  ...(tightShadow ? { shadow: { target: [0, 1.5, 0.3], extent: 6, distance: 14, near: 1, far: 30 } } : {}),
  ...(shadowExtent > 0 ? { shadow: { target: [0, 1.5, numberAfter('--shadow-target-z', 0.3)], extent: shadowExtent, distance: shadowExtent * 2.4, near: 1, far: shadowExtent * 5 } } : {}),
};

const workDirectory = await mkdtemp(join(tmpdir(), 'crucible-interior-'));
await mkdir(outputDirectory, { recursive: true });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('bin/crucible-mcp.mjs'), '--backend', backend, '--memory', '384', '--jobs', join(workDirectory, 'jobs')],
  cwd: workDirectory,
  stderr: 'pipe',
});
const client = new Client({ name: 'interior-exposure', version: '1' });

async function call(name, toolArguments) {
  const result = await client.callTool({ name, arguments: toolArguments }, { timeout: 240000 });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return result.structuredContent;
}

async function render(sessionId, name, renderer) {
  const settings = { kind: 'image', width: WIDTH, height: HEIGHT, ...(renderer ? { renderer } : {}) };
  const { jobId } = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings });
  for (;;) {
    const record = await call('scene_render_status', { jobId });
    if (record.state === 'completed') break;
    assert.ok(!['failed', 'cancelled'].includes(record.state), JSON.stringify(record));
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  const result = await call('scene_render_result', { jobId });
  await copyFile(result.artifacts[0].path, join(outputDirectory, `${name}.png`));
  return result;
}

async function traceAndReport(sessionId) {
  const traced = await render(sessionId, 'path-traced', {
    type: 'pathTracer', backend, samples, bounces: 6, denoise, seed: 1, maxSeconds: 120,
  });
  console.log(JSON.stringify({ ignored: traced.metrics?.pathTracer?.ignored, diagnostics: traced.diagnostics }, null, 1));
  console.log(`wrote ${outputDirectory}/raster.png and path-traced.png`);
}

try {
  await client.connect(transport);
  const created = await call('scene_create', { recipe });
  await render(created.sessionId, 'raster');
  if (rasterOnly) {
    console.log(`wrote ${outputDirectory}/raster.png`);
  } else {
    await traceAndReport(created.sessionId);
  }
} finally {
  await client.close().catch(() => {});
  await rm(workDirectory, { recursive: true, force: true });
}
