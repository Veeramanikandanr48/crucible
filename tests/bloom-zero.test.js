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
import { isBloomActive, resolveEffects } from '../src/effects.js';
import { CrucibleRenderer } from '../src/renderer.js';
import { decodePngPixels } from './support/png-pixels.mjs';

// Bloom strength 0 means bloom off (#2025): no pass, no targets, no shader step, the same pixels as a scene without bloom.

test('isBloomActive is true only for a strength above 0', () => {
  assert.equal(isBloomActive(resolveEffects({ bloom: { strength: 0 } })), false);
  assert.equal(isBloomActive(resolveEffects({})), false);
  assert.equal(isBloomActive({ bloom: { strength: -0 } }), false);
  assert.equal(isBloomActive({ bloom: { strength: Number.NaN } }), false);
  assert.equal(isBloomActive({}), false);
  assert.equal(isBloomActive(resolveEffects({ bloom: { strength: 0.01 } })), true);
});

test('the post steps of a strength 0 frame hold no bloom step, those of a positive strength do', () => {
  const stepsOf = strength => CrucibleRenderer.prototype.postStepsOf.call({ transparent: false }, {}, resolveEffects({ bloom: { strength } }), { density: 0 }, false, null, false);
  assert.ok(!stepsOf(0).includes('bloom'));
  assert.ok(stepsOf(0.3).includes('bloom'));
});

test('prepareFrame allocates no bloom targets for strength 0 even with other effects set', async () => {
  const calls = [];
  const renderer = { benchmark: false, disposed: false, bloomTargets: [], context: {}, programsReady: async () => {}, ensureBloomTargets: () => calls.push('ensureBloomTargets'), render: () => {} };
  const frame = { effects: { exposure: 1.2, vignette: 0.3, bloom: { strength: 0, threshold: 0.4, radius: 2 } } };
  await CrucibleRenderer.prototype.prepareFrame.call(renderer, frame);
  assert.deepEqual(calls, []);
});

const SIDE = 64;
const directories = [];
const sessions = new Map();
async function server() {
  if (sessions.has('server')) return sessions.get('server');
  const directory = await mkdtemp(join(tmpdir(), 'crucible-bloom-zero-'));
  directories.push(directory);
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const mcp = createAgentMcpServer(runtime);
  const client = new Client({ name: 'bloom-zero-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const entry = { client, close: async () => { await client.close(); await mcp.close(); await runtime.close(); } };
  sessions.set('server', entry);
  return entry;
}
after(async () => {
  if (sessions.has('server')) await sessions.get('server').close();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

async function renderBytes(effects) {
  const { client } = await server();
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    camera: { eye: [0, 1, 6], target: [0, 1, 0], fov: 40 },
    environment: { localVolumes: [{ shape: 'sphere', center: [0, 1, 0], radius: 1, density: 4, emission: [1, 0.6, 0.2], emissionStrength: 30 }] },
    effects,
  };
  const created = await call(client, 'scene_create', { recipe });
  const submitted = await call(client, 'scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: { kind: 'image', width: SIDE, height: SIDE } });
  for (let attempt = 0; attempt < 900; attempt++) {
    const record = await call(client, 'scene_render_status', { jobId: submitted.jobId });
    if (record.state === 'completed') break;
    assert.ok(!['cancelled', 'failed'].includes(record.state), JSON.stringify(record));
    await delay(100);
  }
  const result = await call(client, 'scene_render_result', { jobId: submitted.jobId });
  return decodePngPixels(await readFile(result.artifacts[0].path));
}

test('with bloom strength 0 the threshold and radius change no pixel, and a positive strength does', { timeout: 240000 }, async () => {
  const others = { exposure: 1.2, vignette: 0.3 };
  const plain = await renderBytes({ ...others, bloom: { strength: 0 } });
  assert.deepEqual(await renderBytes({ ...others, bloom: { strength: 0, threshold: 0.1, radius: 4 } }), plain);
  const bloomed = await renderBytes({ ...others, bloom: { strength: 0.5, threshold: 0.1, radius: 4 } });
  assert.notDeepEqual(bloomed, plain, 'the test scene must glow when bloom is on, else the check above proves nothing');
});
