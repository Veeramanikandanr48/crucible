import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { encodeVolumeGrid } from '../src/volume-grid.js';
import { EXPLOSION_EMPTY_VELOCITY_GRID, explosionGridByteLength, setExplosionBakeStore } from '../src/explosion-grids.js';
import { GRID_DIRECTORY_VARIABLE, readVolumeGridFiles, volumeGridFileBytes } from '../src/mcp-volume-grids.js';
import { decodePngPixels, meanBrightness } from './support/png-pixels.mjs';

// Grid volumes through the MCP render path (#1161): the server reads the .67vg files a recipe names and hands their bytes to the preview page, which has
// no file access. Tiny 4x4x4 grids put the density in the left half of the box (frame "left") or the right half (frame "right"), so which frame a
// render drew shows as which side of the picture is bright.

const SIDE = 128;
const FRAMES_PER_SECOND = 10;
const LEFT_HALF = [0.2, 0.3, 0.45, 0.7];
const RIGHT_HALF = [0.55, 0.3, 0.8, 0.7];
const MINIMUM_SIDE_DIFFERENCE = 12;

function halfBoxGrid(side) {
  const density = new Float32Array(64);
  for (let z = 0; z < 4; z++) {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) density[x + y * 4 + z * 16] = (side === 'left' ? x < 2 : x >= 2) ? 1 : 0;
    }
  }
  return encodeVolumeGrid({ resolution: [4, 4, 4], channels: { density }, size: [2, 2, 2] });
}

function gridRecipe(volume) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [], materials: [], nodes: [],
    camera: { eye: [0, 1, 6], target: [0, 1, 0], fov: 40 },
    environment: { localVolumes: [{ shape: 'grid', center: [0, 1, 0], size: [2, 2, 2], density: 6, emission: [1, 1, 1], emissionStrength: 40, ...volume }] },
  };
}

// One server for the file: its tests make their own sessions, so they share only the runtime and its preview browser, whose start costs
// seconds per test. The grid folder holds only the two small grids; the tests that write large files make a folder of their own.
let sharedServerPromise = null;
let closeSharedServer = async () => {};

function sharedServer() {
  sharedServerPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crucible-grid-mcp-'));
    const gridFolder = join(directory, 'grids');
    await mkdir(gridFolder);
    await writeFile(join(gridFolder, 'left.67vg'), halfBoxGrid('left'));
    await writeFile(join(gridFolder, 'right.67vg'), halfBoxGrid('right'));
    const previousFolder = process.env[GRID_DIRECTORY_VARIABLE];
    process.env[GRID_DIRECTORY_VARIABLE] = gridFolder;
    const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
    const server = createAgentMcpServer(runtime);
    const client = new Client({ name: 'grid-volume-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeSharedServer = async () => {
      await client.close();
      await server.close();
      await runtime.close();
      if (previousFolder === undefined) delete process.env[GRID_DIRECTORY_VARIABLE];
      else process.env[GRID_DIRECTORY_VARIABLE] = previousFolder;
      await rm(directory, { recursive: true, force: true });
    };
    return { client, gridFolder };
  })();
  return sharedServerPromise;
}

after(() => closeSharedServer());

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

async function renderStill(client, sessionId, revision, start) {
  const submitted = await call(client, 'scene_render_submit', { sessionId, expectedRevision: revision,
    settings: { kind: 'image', width: SIDE, height: SIDE, ...(start === undefined ? {} : { motion: { start } }) } });
  const deadline = Date.now() + 90000;
  for (;;) {
    const record = await call(client, 'scene_render_status', { jobId: submitted.jobId });
    if (record.state === 'completed') break;
    assert.ok(!['cancelled', 'failed'].includes(record.state), JSON.stringify(record));
    assert.ok(Date.now() < deadline, 'the render job did not finish in 90 seconds');
    await delay(100);
  }
  const result = await call(client, 'scene_render_result', { jobId: submitted.jobId });
  const bytes = await readFile(result.artifacts[0].path);
  const picture = decodePngPixels(bytes);
  return { bytes, left: meanBrightness(picture, LEFT_HALF), right: meanBrightness(picture, RIGHT_HALF) };
}

test('a render job draws a still grid volume from a file in the grid folder', { timeout: 180000 }, async () => {
  const { client } = await sharedServer();
  const created = await call(client, 'scene_create', { recipe: gridRecipe({ grid: 'left.67vg' }) });
  const shot = await renderStill(client, created.sessionId, created.revision ?? 0);
  assert.ok(shot.left - shot.right > MINIMUM_SIDE_DIFFERENCE, `the left half holds the density: left ${shot.left}, right ${shot.right}`);
});

test('a render job draws the grid frame its motion time selects, and scene_apply swaps the grid', { timeout: 240000 }, async () => {
  const { client } = await sharedServer();
  const created = await call(client, 'scene_create', { recipe: gridRecipe({ frames: ['left.67vg', 'right.67vg'], fps: FRAMES_PER_SECOND }) });
  const revision = created.revision ?? 0;
  const firstFrame = await renderStill(client, created.sessionId, revision, 0.01);
  const secondFrame = await renderStill(client, created.sessionId, revision, 0.11);
  const wrapped = await renderStill(client, created.sessionId, revision, 0.21);
  assert.ok(firstFrame.left - firstFrame.right > MINIMUM_SIDE_DIFFERENCE, `0.01 s draws frame 0: left ${firstFrame.left}, right ${firstFrame.right}`);
  assert.ok(secondFrame.right - secondFrame.left > MINIMUM_SIDE_DIFFERENCE, `0.11 s draws frame 1: left ${secondFrame.left}, right ${secondFrame.right}`);
  assert.ok(wrapped.left - wrapped.right > MINIMUM_SIDE_DIFFERENCE, `0.21 s wraps to frame 0: left ${wrapped.left}, right ${wrapped.right}`);
  assert.deepEqual(wrapped.bytes, firstFrame.bytes, 'the same frame gives the same pixels');

  const applied = await call(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: revision,
    operations: [{ type: 'set-environment', environment: { localVolumes: [{ shape: 'grid', grid: 'right.67vg', center: [0, 1, 0], size: [2, 2, 2], density: 6, emission: [1, 1, 1], emissionStrength: 40 }] } }] });
  const swapped = await renderStill(client, created.sessionId, applied.revision);
  assert.ok(swapped.right - swapped.left > MINIMUM_SIDE_DIFFERENCE, `an applied grid draws too: left ${swapped.left}, right ${swapped.right}`);
});

test('a grid name that is not a file in the grid folder is refused with what to pass instead', { timeout: 60000 }, async () => {
  const { client } = await sharedServer();
  for (const [grid, message] of [['absent.67vg', /not in the grid folder/], ['../left.67vg', /never a path/], ['left', /file name such as "blast\.67vg"/]]) {
    const refused = await client.callTool({ name: 'scene_create', arguments: { recipe: gridRecipe({ grid }) } });
    assert.equal(refused.isError, true, grid);
    assert.match(refused.content.find(item => item.type === 'text').text, message);
  }
});

test('grid bytes are bounded by name: one sequence may not pass its byte budget', async context => {
  const gridFolder = await mkdtemp(join(tmpdir(), 'crucible-grid-big-'));
  context.after(() => rm(gridFolder, { recursive: true, force: true }));
  const frames = Array.from({ length: 4 }, (unused, index) => `big${index}.67vg`);
  const bigGrid = Buffer.alloc(64 * 1024 * 1024 + 100);
  for (const name of frames) await writeFile(join(gridFolder, name), bigGrid);
  assert.throws(() => readVolumeGridFiles(gridRecipe({ frames }), gridFolder), /over the 268435456 byte limit for a sequence/);
  await writeFile(join(gridFolder, 'huge.67vg'), Buffer.alloc(64 * 1024 * 1024 + 8192));
  assert.throws(() => readVolumeGridFiles(gridRecipe({ grid: 'huge.67vg' }), gridFolder), /over the 67108864 byte limit; convert it with a lower --max-resolution/);
});

test('volumeGridFileBytes sums distinct file sizes, stops at the combined limit and skips a list over the frame bound (#1246)', async context => {
  const folder = await mkdtemp(join(tmpdir(), 'crucible-grid-bytes-'));
  context.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'a.67vg'), Buffer.alloc(10));
  await writeFile(join(folder, 'b.67vg'), Buffer.alloc(25));
  assert.equal(volumeGridFileBytes(gridRecipe({ frames: ['a.67vg', 'b.67vg', 'a.67vg', 'missing.67vg'] }), folder), 35);
  const overBound = Array.from({ length: 513 }, (unused, index) => `n${index}.67vg`);
  assert.equal(volumeGridFileBytes(gridRecipe({ frames: overBound }), folder), 0);
  assert.throws(() => readVolumeGridFiles(gridRecipe({ frames: overBound }), folder), /at most 512/);
  await writeFile(join(folder, 'big.67vg'), Buffer.alloc(64 * 1024 * 1024 + 1));
  const copies = Array.from({ length: 4 }, (unused, index) => `copy${index}.67vg`);
  for (const name of copies) await writeFile(join(folder, name), Buffer.alloc(40 * 1024 * 1024));
  const total = volumeGridFileBytes(gridRecipe({ frames: ['big.67vg', ...copies] }), folder);
  assert.equal(total, 64 * 1024 * 1024 + 1, 'counting stops at the first file that passes the limit');
});

function totalBytes(files) {
  return [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
}

test('volumeGridFileBytes counts one add-explosion at exactly the bytes it bakes, and distinct blasts once each (#1903)', { timeout: 120000 }, async context => {
  // A fresh private folder with no .67vg files, so every add-explosion grid is counted as baked, not read from disk.
  const emptyFolder = await mkdtemp(join(tmpdir(), 'crucible-no-grids-'));
  context.after(() => rm(emptyFolder, { recursive: true, force: true }));
  for (const motionBlur of [true, false]) {
    const operations = [{ type: 'add-explosion', seed: 3, motionBlur }];
    const counted = volumeGridFileBytes(operations, emptyFolder);
    assert.ok(counted > 0, 'an add-explosion has grid bytes to count');
    assert.equal(counted, totalBytes(readVolumeGridFiles(operations, emptyFolder)), `motionBlur ${motionBlur}: counted bytes equal the baked bytes`);
    assert.equal(volumeGridFileBytes([...operations, { type: 'add-explosion', seed: 3, motionBlur }], emptyFolder), counted, 'the same blast twice counts once');
  }
  const one = volumeGridFileBytes([{ type: 'add-explosion', seed: 1 }], emptyFolder);
  const sharedEmptyFrame = explosionGridByteLength(EXPLOSION_EMPTY_VELOCITY_GRID);
  // Two blasts stay under the combined limit, where counting stops early.
  const two = volumeGridFileBytes(Array.from({ length: 2 }, (unused, index) => ({ type: 'add-explosion', seed: index + 1 })), emptyFolder);
  assert.equal(two, 2 * (one - sharedEmptyFrame) + sharedEmptyFrame, 'two seeds count two sets of frames and one shared empty frame');
  const twelve = volumeGridFileBytes(Array.from({ length: 12 }, (unused, index) => ({ type: 'add-explosion', seed: index + 1 })), emptyFolder);
  assert.ok(twelve > 64 * 1024 * 1024, 'twelve distinct blasts pass the combined limit');
});

test('scene_apply refuses distinct add-explosion operations over the combined limit before baking any of them (#1903)', { timeout: 120000 }, async context => {
  const { client } = await sharedServer();
  const created = await call(client, 'scene_create', { recipe: gridRecipe({ grid: 'left.67vg' }) });
  let bakeAttempts = 0;
  setExplosionBakeStore({ load: () => { bakeAttempts += 1; return null; }, save: () => {} });
  context.after(() => setExplosionBakeStore(null));
  const operations = Array.from({ length: 3 }, (unused, index) => ({ type: 'add-explosion', id: `blast${index}`, center: [index, 0, 0], size: 2, seed: index + 1 }));
  const refused = await client.callTool({ name: 'scene_apply', arguments: { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, operations } });
  assert.equal(refused.isError, true);
  assert.match(refused.content.find(item => item.type === 'text').text, /67108864/);
  assert.equal(bakeAttempts, 0, 'no explosion was baked before the refusal');
});
