import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

// Issue 2049: a wrong hdri or look name used to fail against the 64-hex pattern only.

async function connectedClient(context, runtime) {
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-catalog-reference-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const idleRuntime = { async close() {}, async capabilities() { return { scene: {}, phase: 'idle' }; }, activeSessionId() { return null; } };

async function rejectedEnvironmentMessage(context, environment) {
  const client = await connectedClient(context, idleRuntime);
  const operations = [{ type: 'set-environment', environment }];
  try {
    const result = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 0, operations } });
    return result.content?.[0]?.text ?? '';
  } catch (error) {
    return error.message;
  }
}

test('a wrong environment.hdri lists the built-in names and the catalog option', async context => {
  const message = await rejectedEnvironmentMessage(context, { hdri: 'no-such-hdri' });
  assert.match(message, /environment\.hdri: .*built-in name \(sky-clouds, studio-softbox\)/);
  assert.match(message, /64-character \.hdr ID from scene_asset_catalog/);
  assert.match(message, /got "no-such-hdri"/);
  assert.doesNotMatch(message, /must match pattern/);
});

test('a wrong environment.look lists the preset and bundled look names', async context => {
  const message = await rejectedEnvironmentMessage(context, { look: 'nope' });
  assert.match(message, /environment\.look: .*built-in name \(.*warm.*cool.*contrast.*faded.*teal-orange.*noir/);
  assert.match(message, /64-character \.cube ID from scene_asset_catalog/);
  assert.doesNotMatch(message, /must match pattern/);
});

test('built-in names and 64-hex IDs still pass input validation', async context => {
  const reachedRuntime = [];
  const runtime = { ...idleRuntime, async apply(argumentsValue) { reachedRuntime.push(argumentsValue); return { revision: 1 }; } };
  const client = await connectedClient(context, runtime);
  for (const environment of [{ hdri: 'sky-clouds' }, { look: 'noir' }, { hdri: 'a'.repeat(64) }]) {
    const operations = [{ type: 'set-environment', environment }];
    const result = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 0, operations } }).catch(error => ({ text: error.message }));
    assert.doesNotMatch(result.text ?? result.content?.[0]?.text ?? '', /Input validation error/);
  }
});
