import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

// Issue 2055: the index lists a "schemas" group, and asking for topic schemas used to answer "Unknown topic schemas."

async function connectClient(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'capabilities-group-topic-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function ask(client, topic) {
  return client.callTool({ name: 'scene_capabilities', arguments: { topic } });
}

test('the schemas group answers with the names of its topics', async context => {
  const client = await connectClient(context);
  const index = (await ask(client, undefined)).structuredContent;
  const answer = await ask(client, 'schemas');
  assert.notEqual(answer.isError, true, answer.content?.[0]?.text);
  assert.equal(answer.structuredContent.topic, 'schemas');
  assert.deepEqual(answer.structuredContent.value.topics, index.topics.schemas);
  assert.ok(answer.structuredContent.value.topics.includes('skin'));
});

test('the scene and runtime groups answer the same way, and a list may mix a group with a topic', async context => {
  const client = await connectClient(context);
  const index = (await ask(client, undefined)).structuredContent;
  for (const group of ['scene', 'runtime']) {
    const answer = await ask(client, group);
    assert.notEqual(answer.isError, true, answer.content?.[0]?.text);
    assert.deepEqual(answer.structuredContent.value.topics, index.topics[group]);
  }
  const mixed = await ask(client, ['schemas', 'skin']);
  assert.deepEqual(Object.keys(mixed.structuredContent.answers), ['schemas', 'skin']);
});

test('the index no longer reads as if schemas were a topic to ask for on its own', async context => {
  const client = await connectClient(context);
  const index = (await ask(client, undefined)).structuredContent;
  assert.doesNotMatch(index.how, /; schemas names the full field list/);
  assert.match(index.how, /each name in topics\.schemas gives the full field list/);
});
