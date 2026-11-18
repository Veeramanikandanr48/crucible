#!/usr/bin/env node
// Draws the add-explosion recipe in Glaze (the rasterizer) and scores its peak frame against a Cycles render of the SAME scene, camera, gas and frame (#1736):
// how much the cloud breaks up (silhouette roughness), how fast it fades at its edge, how far its luminance distribution is from the reference's, and an RMSE
// of the two after both are centred and scaled to the same cloud size (scripts/explosion-breakup-metrics.mjs explains the reduction).
//
//   GPU_LOCK_WEIGHT=heavy bash ~/.agents/tools/gpu-lock.sh node scripts/measure-explosion-breakup.mjs --out artifacts/explosion-breakup/before
//
// The Cycles frame (scripts/explosion-cycles-reference.mjs, Blender 5.3 at below normal priority) shows the grid frame the recipe plays at the first time, so it
// moves with the bake: the numbers say how well Glaze matches Cycles on that gas, and the Cycles row of the report says how ragged that gas is in truth.
// Not shared between the two: the sky (Cycles has a flat colour), the sun and the sparks, dust, rubble and debris, which only Glaze draws (sparks are off).
// --reference <png> scores against a Cycles frame already rendered (the grid frame must be the same: 9 for --times 0.45, size 4, seed 1) and runs no Blender.
// --detail off|strength,scale,octaves replaces the volume's detailNoise (#1832) to compare settings on one build.
// --times lists the motion times to draw in Glaze (the first one is scored), --backend gpu|cpu, --blender <exe>, --samples <n>.
// Prints one JSON object and saves frame-<time>.png and the Cycles render as cycles.png.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from './agent-runtime.mjs';
import { createAgentMcpServer } from './mcp-server.mjs';
import { decodePng } from '../bench/agent-modeling/png-check.mjs';
import { compareFrames, describeFrame, luminanceImage } from './explosion-breakup-metrics.mjs';
import { renderCyclesReference } from './explosion-cycles-reference.mjs';

const CYCLES_SIZE = { width: 960, height: 540 };
const FLOOR_COLOR = [0.12, 0.11, 0.1];
const FRAME_SIZE = { width: 1024, height: 576 };

// The scene the evidence stills use: a floor disc and a camera that looks at the blast from above and to the side.
const SCENE = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'disc', type: 'cylinder' }],
  materials: [{ id: 'floor', color: FLOOR_COLOR, roughness: 1 }],
  nodes: [{ id: 'floor', geometry: 'disc', material: 'floor', scale: [9, 0.1, 9], translation: [0, -0.05, 0] }],
  camera: { eye: [0, 3.2, 9], target: [0, 1.6, 0], fov: 40 },
};

function parseArguments(argv) {
  const options = { backend: 'gpu', times: [0.45], samples: 128, size: 4, seed: 1, out: 'artifacts/explosion-breakup/run' };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    if (!['backend', 'times', 'samples', 'size', 'seed', 'out', 'blender', 'reference', 'detail', 'flat', 'view', 'effects', 'volume'].includes(name) || argv[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete option ${argv[index]}; use --out <folder> [--times 0.45,1.2] [--backend gpu|cpu] [--size 4] [--seed 1] [--samples 128] [--blender <exe>] [--reference <cycles.png>] [--detail off|strength,scale,octaves].`);
    }
    options[name] = argv[index + 1];
  }
  options.times = String(options.times).split(',').map(Number);
  options.size = Number(options.size);
  options.seed = Number(options.seed);
  options.samples = Number(options.samples);
  return options;
}

async function connect(backend) {
  const runtime = createAgentRuntime({ backend, memory: 192 });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'measure-explosion-breakup', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); await runtime.close?.(); } };
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? `${name} failed`);
  return result;
}

async function overrideDetailNoise(client, sessionId, revision, detail) {
  const exported = (await call(client, 'scene_export_recipe', { sessionId })).structuredContent;
  const current = exported.recipe ?? exported;
  const volume = { ...current.environment.localVolumes[0] };
  delete volume.detailNoise;
  if (detail !== 'off') {
    const [strength, scale, octaves] = detail.split(',').map(Number);
    volume.detailNoise = { strength, scale, octaves };
  }
  await call(client, 'scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-environment', environment: { localVolumes: [volume] } }] });
}

/** Merges the given fields into the first local volume, to try one emission setting without editing the recipe code. */
async function patchVolume(client, sessionId, revision, patch) {
  const exported = (await call(client, 'scene_export_recipe', { sessionId })).structuredContent;
  const volume = { ...(exported.recipe ?? exported).environment.localVolumes[0], ...patch };
  for (const [field, value] of Object.entries(patch)) if (value === null) delete volume[field];
  await call(client, 'scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-environment', environment: { localVolumes: [volume] } }] });
}

async function drawFrames(options) {
  const { client, close } = await connect(options.backend);
  try {
    const created = (await call(client, 'scene_create', { recipe: SCENE })).structuredContent;
    const operation = { type: 'add-explosion', id: 'blast', center: [0, 0, 0], size: options.size, seed: options.seed, sparks: 'none', motionBlur: false };
    let applied = (await call(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: created.revision, operations: [operation] })).structuredContent;
    const frames = [];
    if (options.flat === '1') {
      const flat = [0.2, 0.22, 0.25];
      applied = (await call(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: applied.revision, operations: [{ type: 'set-motion', motion: null }, { type: 'remove-node', id: 'floor' }, { type: 'remove-node', id: 'blast-dust' }, { type: 'remove-node', id: 'blast-rubble' }, { type: 'remove-node', id: 'blast-scorch' }, { type: 'set-particles', particles: null }, { type: 'set-environment', environment: { skyTop: flat, skyBottom: flat, daylight: 0, ...(options.view ? { viewTransform: options.view } : {}) } }, ...(options.effects ? [{ type: 'set-effects', effects: JSON.parse(options.effects) }] : [])] })).structuredContent;
    }
    if (options.volume) await patchVolume(client, created.sessionId, applied.revision, JSON.parse(options.volume));
    if (options.detail !== undefined) await overrideDetailNoise(client, created.sessionId, applied.revision, options.detail);
    for (const motionTime of options.times) {
      const look = await call(client, 'scene_look', { sessionId: created.sessionId, motionTime, ...FRAME_SIZE });
      const image = look.content.find(item => item.type === 'image');
      frames.push({ motionTime, png: Buffer.from(image.data, 'base64') });
    }
    const exported = (await call(client, 'scene_export_recipe', { sessionId: created.sessionId })).structuredContent;
    await writeFile(join(options.out, 'recipe.json'), JSON.stringify(exported.recipe ?? exported, (key, value) => (key === 'frames' ? undefined : value), 1));
    return { frames, volume: (exported.recipe ?? exported).environment.localVolumes[0] };
  } finally {
    await close();
  }
}

const options = parseArguments(process.argv.slice(2));
await mkdir(options.out, { recursive: true });
const { frames, volume } = await drawFrames(options);
const frameIndex = Math.round(options.times[0] * volume.fps);
const cyclesPng = options.reference ?? await renderCyclesReference({ volume, frameIndex, camera: SCENE.camera, floor: options.flat === '1' ? null : 0, floorColor: FLOOR_COLOR, folder: join(options.out, 'cycles-work'), ...CYCLES_SIZE, samples: options.samples, blender: options.blender });
await copyFile(cyclesPng, join(options.out, 'cycles.png'));
const reference = describeFrame(luminanceImage(decodePng(await readFile(cyclesPng))));
const report = { backend: options.backend, size: options.size, seed: options.seed, gridFrame: frameIndex, samples: options.samples, times: [] };
for (const [position, frame] of frames.entries()) {
  await writeFile(join(options.out, `frame-${frame.motionTime}.png`), frame.png);
  const described = describeFrame(luminanceImage(decodePng(frame.png)));
  const entry = { motionTime: frame.motionTime, cloudRadiusPixels: Math.round(described.geometry.radius), roughness: described.roughness, edgeFalloff: described.edgeFalloff };
  if (position === 0) entry.againstReference = compareFrames(reference, described);
  report.times.push(entry);
}
report.reference = { cloudRadiusPixels: Math.round(reference.geometry.radius), roughness: reference.roughness, edgeFalloff: reference.edgeFalloff };
await writeFile(join(options.out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
