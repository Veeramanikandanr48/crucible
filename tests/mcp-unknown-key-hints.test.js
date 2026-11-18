import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { suggestionForRejectedKey } from '../scripts/mcp-input-errors.mjs';

// The schema refuses these recipes before the runtime is called, so the runtime needs no methods.
async function connect(context) {
  const server = createAgentMcpServer({ activeSessionId: () => null, async close() {} });
  const client = new Client({ name: 'unknown-key-hints-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const COLOUR_RECIPE = {
  format: 'crucible.scene', schemaVersion: 1,
  materials: [{ id: 'red', emission: [1, 0.6, 0.2] }],
  nodes: [{ id: 'floor', material: 'red' }],
};

async function refusalText(client, recipe) {
  try {
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe } });
    return result.content.map(part => part.text ?? '').join('\n');
  } catch (error) {
    return error.message;
  }
}

const GUESSED_RECIPE = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'floor', type: 'box', size: [6, 0.1, 6] }, { id: 'ball', type: 'sphere', radius: 0.5 }],
  materials: [{ id: 'red', color: [0.8, 0.1, 0.1], metalness: 0.5, tags: ['water'] }],
  nodes: [{ id: 'floor', geometry: 'floor', material: 'red', position: [0, 0, 0] }],
  lights: [{ type: 'directional' }],
};

test('an unrecognized key in a recipe names the valid key or the place it lives', async context => {
  const client = await connect(context);
  const text = await refusalText(client, GUESSED_RECIPE);
  assert.match(text, /Use "translation" instead of "position"/);
  assert.match(text, /Use "metallic" instead of "metalness"/);
  assert.match(text, /Use "tag" instead of "tags"/);
  assert.match(text, /For "lights": .*environment\.pointLights/);
  assert.match(text, /For "size": .*"scale" of its node/);
  assert.match(text, /For "radius": .*"scale" of its node/);
});

test('a colour passed to a numeric field points at the colour sibling', async context => {
  const client = await connect(context);
  const text = await refusalText(client, COLOUR_RECIPE);
  assert.match(text, /emission takes one number.*use emissiveColor/);
});

test('a misspelt key gets its nearest valid key and an unrelated key gets nothing', () => {
  assert.match(suggestionForRejectedKey('rougness', ['roughness', 'metallic']), /Use "roughness" instead of "rougness"/);
  assert.equal(suggestionForRejectedKey('banana', ['roughness', 'metallic']), undefined);
  assert.equal(suggestionForRejectedKey('constructor', ['roughness']), undefined);
});
