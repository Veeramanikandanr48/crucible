import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

// Issue 1872: Haiku walked the capability topics one call at a time, so topic also takes a list.

async function connectClient(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'capabilities-topic-list-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function ask(client, argumentsValue) {
  return client.callTool({ name: 'scene_capabilities', arguments: argumentsValue });
}

const LISTED = ['meshEdit.inset_region', 'meshEdit.extrude_individual', 'geometries.mesh'];

test('a topic list answers every name, each the same as its single call', async context => {
  const client = await connectClient(context);
  const listed = await ask(client, { topic: LISTED });
  assert.notEqual(listed.isError, true);
  assert.deepEqual(Object.keys(listed.structuredContent.answers), LISTED);
  for (const topic of LISTED) {
    const single = await ask(client, { topic });
    assert.deepEqual(listed.structuredContent.answers[topic], single.structuredContent);
  }
});

test('a string topic keeps its shape, and the index says a list is allowed', async context => {
  const client = await connectClient(context);
  const single = await ask(client, { topic: 'geometries.mesh' });
  assert.equal(single.structuredContent.answers, undefined);
  assert.equal(single.structuredContent.topic, 'geometries.mesh');
  const index = await ask(client, {});
  assert.match(index.structuredContent.how, /list of up to 8 names/);
});

test('every unknown entry of a list is named with its own suggestion, in one error', async context => {
  const client = await connectClient(context);
  const result = await ask(client, { topic: ['geometres', 'meshEdit.inset_region', 'materialFeilds'] });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /Unknown topic geometres\. Did you mean geometries\?/);
  assert.match(text, /Unknown topic materialFeilds\. Did you mean materialFields\?/);
  assert.doesNotMatch(text, /Unknown topic meshEdit/);
  assert.equal(text.match(/Topics: /g).length, 1);
});

test('a list is bounded and holds no repeats', async context => {
  const client = await connectClient(context);
  const tooMany = await ask(client, { topic: Array.from({ length: 9 }, (_, position) => `meshEdit.op${position}`) });
  assert.equal(tooMany.isError, true);
  const empty = await ask(client, { topic: [] });
  assert.equal(empty.isError, true);
  const repeated = await ask(client, { topic: ['geometries', 'geometries'] });
  assert.equal(repeated.isError, true);
  assert.match(repeated.content[0].text, /repeats geometries/);
});

test('concise format drops the notes inside each listed topic', async context => {
  const client = await connectClient(context);
  const detailed = await ask(client, { topic: ['environment', 'materialFields'], response_format: 'detailed' });
  const concise = await ask(client, { topic: ['environment', 'materialFields'], response_format: 'concise' });
  assert.ok(JSON.stringify(concise.structuredContent).length < JSON.stringify(detailed.structuredContent).length);
  const singleConcise = await ask(client, { topic: 'environment', response_format: 'concise' });
  assert.deepEqual(concise.structuredContent.answers.environment, singleConcise.structuredContent);
});
