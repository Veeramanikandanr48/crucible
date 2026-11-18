import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

// scene_capabilities lists the material layers; the MCP schema must take every one of them (#2090: dispersion was listed
// but scene_create answered Unrecognized key). alphaMode is not a layer field, so #2091 is not covered here.

async function connectClient() {
  const server = createAgentMcpServer({ async close() {}, async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle' }; } });
  const client = new Client({ name: 'crucible-material-layer-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function exampleValue(range) {
  if (Array.isArray(range) && range.length === 2 && typeof range[0] === 'number') {
    return range[0] + (range[1] - range[0]) / 4;
  }
  if (Array.isArray(range)) return [0.5, 0.5, 0.5];
  return 1;
}

function schemaErrorText(result) {
  return result.isError ? JSON.stringify(result.content) : '';
}

test('every material layer scene_capabilities lists is in materialFields and accepted by scene_create and set-material', async () => {
  const { client, server } = await connectClient();
  const layers = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'materialLayers' } })).structuredContent.value;
  const listedFields = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'materialFields' } })).structuredContent.fields;
  const layerNames = Object.keys(layers);
  assert.ok(layerNames.includes('dispersion'), 'materialLayers lists dispersion');
  const problems = [];
  for (const field of layerNames) {
    const { range } = layers[field];
    const value = exampleValue(range);
    if (!listedFields[`${field}?`]) problems.push(`materialFields has no ${field}`);
    const created = await client.callTool({
      name: 'scene_create',
      arguments: { recipe: { format: 'crucible.scene', schemaVersion: 1, materials: [{ id: 'm', color: [1, 1, 1], [field]: value }] } },
    });
    if (/Unrecognized key/.test(schemaErrorText(created))) problems.push(`scene_create rejects ${field}`);
    const edited = await client.callTool({
      name: 'scene_apply',
      arguments: { operations: [{ type: 'set-material', id: 'm', [field]: value }] },
    });
    if (/Unrecognized key/.test(schemaErrorText(edited))) problems.push(`set-material rejects ${field}`);
  }
  assert.deepEqual(problems, []);
  await client.close();
  await server.close();
});
