import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { decodePngPixels, meanBrightness } from './support/png-pixels.mjs';

// Camera, light and morph drivers through the MCP render path (#1995): scene_create used to refuse the driver targets that the library and
// docs/agent-motion.md accept. A white box on a dark background gives the picture a mean brightness that follows how much of the frame the box fills.

const SIDE = 96;
const WHOLE_PICTURE = [0, 0, 1, 1];
const MINIMUM_CHANGE = 3;

function boxRecipe(drivers) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'white', color: [1, 1, 1], emission: 1, emissiveColor: [1, 1, 1] }],
    nodes: [{ id: 'box', geometry: 'cube', material: 'white' }],
    camera: { eye: [0, 0, 8], target: [0, 0, 0], fov: 40 },
    motion: { duration: 2, drivers },
  };
}

const fovDriver = { target: { kind: 'camera', property: 'fov' }, expression: { add: [20, { mul: [20, 'time'] }] } };
const eyeZDriver = { target: { kind: 'camera', property: 'eye', component: 'z' }, expression: { sub: [8, { mul: [3, 'time'] }] } };

let sharedServerPromise = null;
let closeSharedServer = async () => {};

function sharedServer() {
  sharedServerPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crucible-camera-driver-mcp-'));
    const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
    const server = createAgentMcpServer(runtime);
    const client = new Client({ name: 'camera-driver-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeSharedServer = async () => {
      await client.close();
      await server.close();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    };
    return client;
  })();
  return sharedServerPromise;
}

after(() => closeSharedServer());

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

async function brightnessAt(client, created, start) {
  const submitted = await call(client, 'scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0,
    settings: { kind: 'image', width: SIDE, height: SIDE, motion: { start } } });
  const deadline = Date.now() + 90000;
  for (;;) {
    const record = await call(client, 'scene_render_status', { jobId: submitted.jobId });
    if (record.state === 'completed') break;
    assert.ok(!['cancelled', 'failed'].includes(record.state), JSON.stringify(record));
    assert.ok(Date.now() < deadline, 'the render job did not finish in 90 seconds');
    await delay(100);
  }
  const result = await call(client, 'scene_render_result', { jobId: submitted.jobId });
  return meanBrightness(decodePngPixels(await readFile(result.artifacts[0].path)), WHOLE_PICTURE);
}

test('a render job draws a camera fov driver: a wider lens at 1 s shrinks the box', { timeout: 180000 }, async () => {
  const client = await sharedServer();
  const created = await call(client, 'scene_create', { recipe: boxRecipe([fovDriver]) });
  const atStart = await brightnessAt(client, created, 0);
  const atOneSecond = await brightnessAt(client, created, 1);
  assert.ok(atStart - atOneSecond > MINIMUM_CHANGE, `fov 20 at 0 s fills more than fov 40 at 1 s: ${atStart} against ${atOneSecond}`);
});

test('a render job draws a camera eye z driver: a nearer eye at 1 s grows the box', { timeout: 180000 }, async () => {
  const client = await sharedServer();
  const created = await call(client, 'scene_create', { recipe: boxRecipe([eyeZDriver]) });
  const atStart = await brightnessAt(client, created, 0);
  const atOneSecond = await brightnessAt(client, created, 1);
  assert.ok(atOneSecond - atStart > MINIMUM_CHANGE, `eye z 8 at 0 s fills less than eye z 5 at 1 s: ${atStart} against ${atOneSecond}`);
});

test('scene_create takes a light driver target and names what a camera eye driver lacks', async () => {
  const client = await sharedServer();
  const lightDriver = { target: { kind: 'light', id: 'point:0', property: 'intensity' }, expression: { mul: [5, 'time'] } };
  const recipe = boxRecipe([lightDriver]);
  recipe.environment = { pointLights: [{ position: [0, 3, 3], intensity: 10 }] };
  await call(client, 'scene_create', { recipe });
  const refused = await client.callTool({ name: 'scene_create', arguments: { recipe: boxRecipe([{ target: { kind: 'camera', property: 'eye' }, expression: 1 }]) } });
  assert.equal(refused.isError, true);
  assert.match(refused.content.find(item => item.type === 'text').text, /camera eye needs a component/);
});

test('scene_create takes a driver-only motion without tracks and refuses a motion with neither tracks nor drivers', async () => {
  const client = await sharedServer();
  const driverOnly = boxRecipe([fovDriver]);
  assert.equal(Object.hasOwn(driverOnly.motion, 'tracks'), false);
  await call(client, 'scene_create', { recipe: driverOnly });
  const refused = await client.callTool({ name: 'scene_create', arguments: { recipe: { ...boxRecipe([]), motion: { duration: 2 } } } });
  assert.equal(refused.isError, true);
  assert.match(refused.content.find(item => item.type === 'text').text, /at least one track or driver/);
});
