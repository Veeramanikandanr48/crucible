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

test('a list with unknown entries answers the valid ones and reports each unknown with its suggestion', async context => {
  const client = await connectClient(context);
  const result = await ask(client, { topic: ['geometres', 'meshEdit.inset_region', 'materialFeilds'] });
  assert.notEqual(result.isError, true);
  const { answers, unknown } = result.structuredContent;
  assert.deepEqual(Object.keys(answers), ['meshEdit.inset_region']);
  const single = await ask(client, { topic: 'meshEdit.inset_region' });
  assert.deepEqual(answers['meshEdit.inset_region'], single.structuredContent);
  assert.equal(unknown.length, 2);
  assert.match(unknown[0], /Unknown topic geometres\. Did you mean geometries\?/);
  assert.match(unknown[1], /Unknown topic materialFeilds\. Did you mean materialFields\?/);
});

// Issue 1929: Haiku sent select and mesh beside valid topics and lost the whole answer.
test('the unknown names beside valid topics stay bounded', async context => {
  const client = await connectClient(context);
  const topic = ['meshUv', 'bogusa', 'bogusb', 'bogusc', 'bogusd', 'boguse', 'bogusf'];
  const result = await ask(client, { topic });
  assert.notEqual(result.isError, true);
  assert.deepEqual(Object.keys(result.structuredContent.answers), ['meshUv']);
  assert.equal(result.structuredContent.unknown.length, 4);
  assert.equal(result.structuredContent.moreUnknown, 2);
  assert.doesNotMatch(JSON.stringify(result.structuredContent.unknown), /Topics: /);
});

test('a list where nothing is known still fails, with every topic named once', async context => {
  const client = await connectClient(context);
  const result = await ask(client, { topic: ['bogusa', 'bogusb'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown topic bogusa\..*Unknown topic bogusb\./);
  assert.equal(result.content[0].text.match(/Topics: /g).length, 1);
});

test('a bad branch of a valid topic in a list is reported beside the other answers', async context => {
  const client = await connectClient(context);
  const result = await ask(client, { topic: ['meshUv', 'meshEdit.no_such_op'] });
  assert.notEqual(result.isError, true);
  assert.deepEqual(Object.keys(result.structuredContent.answers), ['meshUv']);
  assert.match(result.structuredContent.unknown[0], /Topic meshEdit has no branch no_such_op/);
});

test('a bare op name or the plural meshEdits form names the dotted meshEdit.<op> topic', async context => {
  const client = await connectClient(context);
  const bare = await ask(client, { topic: 'uv_unwrap' });
  assert.equal(bare.isError, true);
  assert.match(bare.content[0].text, /Did you mean [^?]*meshEdit\.uv_unwrap/);
  const plural = await ask(client, { topic: 'meshEdits.uv_unwrap' });
  assert.equal(plural.isError, true);
  assert.match(plural.content[0].text, /uv_unwrap is a branch: ask .*meshEdit\.uv_unwrap/);
  const inList = await ask(client, { topic: ['meshUv', 'uv_unwrap'] });
  assert.match(inList.structuredContent.unknown[0], /meshEdit\.uv_unwrap/);
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

// Issue 1904: names inherited from Object.prototype are not fields or entries.
test('a field name inherited from Object.prototype is not a field of a topic', async context => {
  const client = await connectClient(context);
  for (const inherited of ['constructor', '__proto__', 'toString']) {
    const result = await ask(client, { topic: `environment.${inherited}` });
    assert.equal(result.isError, true, inherited);
    assert.match(result.content[0].text, new RegExp(`Topic environment has no field ${inherited}\\. Fields: `));
  }
});

test('a dotted suffix that is not an entry of a plain topic names the entries', async context => {
  const client = await connectClient(context);
  for (const topic of ['particles.nonexistent', 'particles.constructor', 'examples.nonexistent']) {
    const result = await ask(client, { topic });
    assert.equal(result.isError, true, topic);
    const [name, entry] = topic.split('.');
    assert.match(result.content[0].text, new RegExp(`Topic ${name} has no (entry|field) ${entry}\\. (Entries|Fields): `));
  }
  const real = await ask(client, { topic: 'examples.scene_apply' });
  assert.notEqual(real.isError, true);
});
