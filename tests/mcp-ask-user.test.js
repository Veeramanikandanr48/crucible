import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

async function connect(context, runtime) {
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'ask-user-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('scene_ask_user passes bounded arguments and returns the marked picture with the marks', async context => {
  const calls = [];
  const marks = [{ number: 1, pixel: [10, 20], note: 'dull', partId: 'lamp', point: [0, 1, 2], normal: [0, 1, 0], distance: 3, material: 'brass' }];
  const client = await connect(context, {
    activeSessionId: () => 'scene-1',
    async close() {},
    async askUser(input) {
      calls.push(input);
      return { image: PNG, content: { sessionId: input.sessionId, outcome: 'sent', marks } };
    },
  });
  const result = await client.callTool({ name: 'scene_ask_user', arguments: { prompt: 'Pin the dull part' } });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].sessionId, 'scene-1');
  assert.equal(calls[0].maxMarks, 16);
  assert.equal(calls[0].timeoutSeconds, 300);
  assert.equal('motionTime' in calls[0], false);
  assert.equal(result.content[0].type, 'image');
  assert.equal(JSON.parse(result.content[1].text).marks[0].partId, 'lamp');
});

test('scene_ask_user returns text only for a timeout and rejects out-of-range arguments', async context => {
  const client = await connect(context, {
    activeSessionId: () => 'scene-1',
    async close() {},
    async askUser() { return { content: { outcome: 'timeout', marks: [] } }; },
  });
  const timedOut = await client.callTool({ name: 'scene_ask_user', arguments: { timeoutSeconds: 10 } });
  assert.deepEqual(timedOut.content.map(part => part.type), ['text']);
  for (const argumentsValue of [{ maxMarks: 17 }, { maxMarks: 0 }, { motionTime: -1 }, { motionTime: 3601 }, { motionTime: 'late' }, { timeoutSeconds: 901 }, { prompt: 'x'.repeat(201) }, { code: 'alert(1)' }, { url: 'https://example.test' }]) {
    const rejected = await client.callTool({ name: 'scene_ask_user', arguments: argumentsValue }).catch(error => ({ isError: true, message: error.message }));
    assert.equal(rejected.isError, true, JSON.stringify(argumentsValue));
  }
});

test('scene_ask_user passes a review file instead of opening the browser, and bounds its size (#924)', async context => {
  const calls = [];
  const client = await connect(context, {
    activeSessionId: () => 'scene-1',
    async close() {},
    async askUser(input) {
      calls.push(input);
      return { content: { sessionId: input.sessionId, outcome: 'sent', marks: [] } };
    },
  });
  const result = await client.callTool({ name: 'scene_ask_user', arguments: { reviewFile: '{"format":"crucible.review"}' } });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].reviewFile, '{"format":"crucible.review"}');
  assert.deepEqual(result.content.map(part => part.type), ['text']);
  const tooLong = await client.callTool({ name: 'scene_ask_user', arguments: { reviewFile: 'x'.repeat(16385) } }).catch(error => ({ isError: true, message: error.message }));
  assert.equal(tooLong.isError, true);
});

test('scene_export_web passes the review flag and rejects other values (#924)', async context => {
  const calls = [];
  const client = await connect(context, {
    activeSessionId: () => 'scene-1',
    async close() {},
    async exportWeb(input) {
      calls.push(input);
      return { sessionId: input.sessionId, review: input.review === true };
    },
  });
  await client.callTool({ name: 'scene_export_web', arguments: { review: true } });
  assert.equal(calls[0].review, true);
  const rejected = await client.callTool({ name: 'scene_export_web', arguments: { review: 'yes' } }).catch(error => ({ isError: true, message: error.message }));
  assert.equal(rejected.isError, true);
});

test('scene_ask_user passes motionTime to the runtime (#922)', async context => {
  const calls = [];
  const client = await connect(context, {
    activeSessionId: () => 'scene-1',
    async close() {},
    async askUser(input) {
      calls.push(input);
      return { content: { outcome: 'sent', marks: [], view: { motionTime: input.motionTime } } };
    },
  });
  const result = await client.callTool({ name: 'scene_ask_user', arguments: { motionTime: 1.5 } });
  assert.equal(calls[0].motionTime, 1.5);
  assert.equal(JSON.parse(result.content[0].text).view.motionTime, 1.5);
});
