import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { decodePngPixels, meanBrightness } from './support/png-pixels.mjs';

// Issue 1983: ambientIntensity multiplies the HDRI's diffuse light and reflections, so an HDRI-only scene with ambientIntensity 0
// renders black. The environment topic must say so, and the render must do what the text says.

async function startServer(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-hdri-ambient-'));
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'hdri-ambient-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    await runtime.close?.();
  });
  return client;
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

function recipeWith(environment) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ball', type: 'sphere' }],
    materials: [{ id: 'plain', color: [0.7, 0.7, 0.7], roughness: 0.8 }],
    nodes: [{ id: 'ball', geometry: 'ball', material: 'plain' }],
    camera: { eye: [0, 0, 3], target: [0, 0, 0] },
    environment: { hdri: 'sky-clouds', keyIntensity: 0, fillIntensity: 0, ground: false, ...environment },
  };
}

async function ballBrightness(client, environment) {
  const created = await call(client, 'scene_create', { recipe: recipeWith(environment) });
  const look = await call(client, 'scene_look', { sessionId: created.structuredContent.sessionId, width: 128, height: 128 });
  const bytes = Buffer.from(look.content.find(item => item.type === 'image').data, 'base64');
  return meanBrightness(decodePngPixels(bytes), [0.4, 0.4, 0.6, 0.6]);
}

test('the environment topic says ambientIntensity scales the HDRI, and the render agrees', { timeout: 240000 }, async context => {
  const client = await startServer(context);
  const topic = JSON.stringify((await call(client, 'scene_capabilities', { topic: 'environment' })).structuredContent);
  assert.match(topic, /ambientIntensity\?":"[^"]*hdri[^"]*diffuse light and reflections/);
  assert.match(topic, /keep it above 0 and set key and fill to 0/);
  const lit = await ballBrightness(client, { ambientIntensity: 1 });
  const black = await ballBrightness(client, { ambientIntensity: 0, environmentIntensity: 1.4 });
  assert.ok(lit > 20, `an HDRI-lit ball with ambientIntensity 1 should be visible, mean ${lit}`);
  assert.ok(black < 1, `ambientIntensity 0 blacks the HDRI out whatever environmentIntensity is, mean ${black}`);
});
