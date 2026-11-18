import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES, normalizeAgentLook } from '../src/agent-scene.js';
import { resolveEffects } from '../src/effects.js';

// Issue 1984: the effects topic said AO defaults to 0.7 while the ambientOcclusion topic and the runtime default to 0.

async function connectClient(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'ambient-occlusion-default-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function readTopic(client, topic) {
  const answer = await client.callTool({ name: 'scene_capabilities', arguments: { topic } });
  assert.notEqual(answer.isError, true);
  return answer.structuredContent;
}

test('both capability topics report the ambient occlusion default the runtime applies', async context => {
  const runtimeDefault = resolveEffects({}).ambientOcclusion;
  assert.equal(normalizeAgentLook({}).effects.ambientOcclusion, runtimeDefault);
  const client = await connectClient(context);
  const occlusionTopic = await readTopic(client, 'ambientOcclusion');
  assert.equal(JSON.stringify(occlusionTopic).includes(`"default":${runtimeDefault}`), true);
  const effectsText = JSON.stringify(await readTopic(client, 'effects'));
  const stated = /ambientOcclusion[^]*?Default ([0-9.]+)/.exec(effectsText);
  assert.ok(stated, 'the effects topic must state the ambientOcclusion default');
  assert.equal(Number(stated[1]), runtimeDefault);
});
