import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from './mcp-server.mjs';

// The tools scripts/mcp-server.mjs registers are the single source of truth for the tool list.
// Smoke scripts compare what a spawned server lists against it instead of repeating a count.
export async function listRegisteredToolNames() {
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: 'crucible-registered-tool-names', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map(tool => tool.name).sort();
}

// Throws an error that names the missing and extra tools; returns the listed names.
export async function assertToolNamesMatchServer(listedTools) {
  const listedNames = listedTools.map(tool => tool.name).sort();
  const registeredNames = await listRegisteredToolNames();
  const missing = registeredNames.filter(name => !listedNames.includes(name));
  const extra = listedNames.filter(name => !registeredNames.includes(name));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `tools/list differs from the tools scripts/mcp-server.mjs registers (${listedNames.length} listed, ${registeredNames.length} registered)`,
  );
  return listedNames;
}

export async function assertToolListMatchesServer(client) {
  return assertToolNamesMatchServer((await client.listTools()).tools);
}
