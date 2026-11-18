// scene_export_glb through the real MCP server on the CPU backend (issues 2127 and 2129): a child under a rotated,
// unevenly scaled parent keeps its place in the file, and export errors name the node or material and the way out.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readGlb } from '../scripts/recode-glb-textures.mjs';

const BOUNDS_TOLERANCE = 1e-4;
const CAMERA = { eye: [3, 2, 4], target: [0, 0.5, 0], fov: 45 };
let directory;
let client;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crucible-export-transforms-'));
  await mkdir(join(directory, 'assets'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--assets', join(directory, 'assets'), '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
  client = new Client({ name: 'crucible-export-transforms-test', version: '1' });
  await client.connect(transport, { timeout: 240000 });
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

function recipeOf(nodes, materials = [{ id: 'm' }]) {
  return { format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'cone', type: 'cone' }, { id: 'box', type: 'box' }], materials, nodes, camera: CAMERA };
}

async function call(name, argumentsValue) {
  return client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
}

async function createScene(recipe) {
  const created = await call('scene_create', { recipe });
  assert.equal(created.isError, undefined, created.content?.[0]?.text);
  return created.structuredContent.sessionId;
}

async function exportError(recipe) {
  const exported = await call('scene_export_glb', { sessionId: await createScene(recipe) });
  assert.equal(exported.isError, true, 'the export should fail');
  return exported.content[0].text;
}

async function worldBounds(sessionId) {
  const report = (await call('scene_inspect', { sessionId, includeBounds: true })).structuredContent;
  const boxes = report.nodes.filter(node => node.bounds).map(node => node.bounds);
  assert.ok(boxes.length > 0, 'the scene should report bounds');
  const min = [0, 1, 2].map(axis => Math.min(...boxes.map(box => box.min[axis])));
  const max = [0, 1, 2].map(axis => Math.max(...boxes.map(box => box.max[axis])));
  return { min, max };
}

test('a child under a rotated, unevenly scaled parent keeps its bounds through export and reimport', { timeout: 300000 }, async () => {
  const recipe = recipeOf([
    { id: 'group', scale: [1, 2, 1], rotation: [0, 0, 0.3826834, 0.9238795], translation: [0, 0, 6] },
    { id: 'kid', parent: 'group', geometry: 'cone', material: 'm', translation: [0, 1, 0] }]);
  const authored = await worldBounds(await createScene(recipe));
  const exported = await call('scene_export_glb', { sessionId: await createScene(recipe) });
  assert.equal(exported.isError, undefined, exported.content?.[0]?.text);
  await copyFile(exported.structuredContent.path, join(directory, 'assets', 'sheared-parent.glb'));
  const catalog = (await call('scene_asset_catalog', {})).structuredContent;
  const asset = catalog.assets.find(entry => entry.name === 'sheared-parent.glb' || entry.filename === 'sheared-parent.glb') ?? catalog.assets[0];
  const assetId = asset.assetId ?? asset.id;
  const imported = await call('scene_create_asset', { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId } });
  assert.equal(imported.isError, undefined, imported.content?.[0]?.text);
  const reimported = await worldBounds(imported.structuredContent.sessionId);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(reimported.min[axis] - authored.min[axis]) < BOUNDS_TOLERANCE, `min[${axis}] ${reimported.min[axis]} against ${authored.min[axis]}`);
    assert.ok(Math.abs(reimported.max[axis] - authored.max[axis]) < BOUNDS_TOLERANCE, `max[${axis}] ${reimported.max[axis]} against ${authored.max[axis]}`);
  }
  const { json } = readGlb(await readFile(exported.structuredContent.path));
  const kid = json.nodes.find(node => node.name === 'kid');
  const expected = [0.7071068, 0.7071068, 0, 0, -1.4142136, 1.4142136, 0, 0, 0, 0, 1, 0, -1.4142136, 1.4142136, 6, 1];
  kid.matrix.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-4, `matrix[${index}] ${value} against ${expected[index]}`));
});

test('a sheared node is named with its parent chain and the way out', { timeout: 120000 }, async () => {
  const message = await exportError(recipeOf([
    { id: 'p', scale: [3, 1, 1] },
    { id: 'shear', parent: 'p', geometry: 'box', material: 'm', rotation: [0, 0.3826834, 0, 0.9238795] }]));
  assert.match(message, /part "shear" \(p > shear\) cannot preserve shear/);
  assert.match(message, /Put the stretch on the node that holds the mesh/);
  assert.match(message, /uniform scale/);
});

test('an emissive color above 1 passes scene_create and exports as color and emissive strength', { timeout: 120000 }, async () => {
  const materials = [{ id: 'hot', color: [1, 0.5, 0.1], emission: 2, emissiveColor: [2, 1, 0.5] }];
  const sessionId = await createScene(recipeOf([{ id: 'lamp', geometry: 'box', material: 'hot' }], materials));
  const exported = await call('scene_export_glb', { sessionId });
  assert.equal(exported.isError, undefined, exported.content?.[0]?.text);
  const { json } = readGlb(await readFile(exported.structuredContent.path));
  const [material] = json.materials;
  assert.deepEqual(material.emissiveFactor, [1, 0.5, 0.25]);
  assert.equal(material.extensions.KHR_materials_emissive_strength.emissiveStrength, 4);
});
