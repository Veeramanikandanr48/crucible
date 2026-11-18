import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES, RECIPE_ALPHA_MODES } from '../src/agent-scene-capabilities.js';

function recipeWithAlphaMode(alphaMode) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'm', color: [0.5, 0.5, 0.5], alphaMode }],
    nodes: [{ id: 'mesh', geometry: 'cube', material: 'm' }],
  };
}

async function connectedClient(context) {
  const acceptedRecipes = [];
  const runtime = {
    async close() {},
    async capabilities() { return { scene: {}, phase: 'idle' }; },
    async create({ recipe }) { acceptedRecipes.push(recipe); return { sessionId: 'session', revision: 1 }; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-alpha-modes-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, acceptedRecipes };
}

test('scene_capabilities alphaModes lists exactly the modes the recipe schema accepts', async context => {
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.alphaModes, [...RECIPE_ALPHA_MODES]);
  const { client, acceptedRecipes } = await connectedClient(context);
  for (const alphaMode of AGENT_SCENE_CAPABILITIES.alphaModes) {
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWithAlphaMode(alphaMode) } });
    assert.notEqual(result.isError, true, `scene_capabilities lists alphaMode "${alphaMode}" but scene_create rejects it: ${JSON.stringify(result.content)}`);
  }
  assert.equal(acceptedRecipes.length, AGENT_SCENE_CAPABILITIES.alphaModes.length);
});

test('scene_create rejects an alphaMode that scene_capabilities does not list', async context => {
  const { client } = await connectedClient(context);
  const result = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWithAlphaMode('mask') } }).catch(error => ({ isError: true, content: error.message }));
  assert.equal(result.isError, true);
});
