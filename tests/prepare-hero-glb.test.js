import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SCRIPT = new URL('../scripts/prepare-hero-glb.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const MESHOPT = 'EXT_meshopt_compression';

function paddedChunk(typeCode, bytes, paddingByte) {
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4, paddingByte)]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(padded.length, 0);
  header.writeUInt32LE(typeCode, 4);
  return Buffer.concat([header, padded]);
}

function buildGlb(document, binary) {
  const body = Buffer.concat([paddedChunk(0x4e4f534a, Buffer.from(JSON.stringify(document)), 0x20), paddedChunk(0x004e4942, binary, 0)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

function readJson(glb) {
  return JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
}

/** Two meshes: a triangle, and a second one whose only primitive has an index accessor with no indices. */
function triangleAndEmptyMeshGlb() {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const indices = Buffer.from(new Uint16Array([0, 1, 2]).buffer);
  const binary = Buffer.concat([positions, indices]);
  const document = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 1 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }, { primitives: [{ attributes: { POSITION: 0 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: UNSIGNED_SHORT, count: 3, type: 'SCALAR' },
      { bufferView: 1, componentType: UNSIGNED_SHORT, count: 0, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    buffers: [{ byteLength: binary.length }],
  };
  return buildGlb(document, binary);
}

test('packing never writes a meshopt view with count 0 and removes a mesh that has no triangles', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'prepare-hero-glb-'));
  try {
    const input = path.join(folder, 'in.glb');
    const output = path.join(folder, 'out.glb');
    await writeFile(input, triangleAndEmptyMeshGlb());
    execFileSync(process.execPath, [SCRIPT, input, output], { stdio: 'pipe' });
    const packed = readJson(await readFile(output));
    const counts = packed.bufferViews.map(view => view.extensions?.[MESHOPT]?.count).filter(count => count !== undefined);
    assert.ok(counts.length > 0 && counts.every(count => count >= 1), `meshopt counts ${counts}`);
    assert.ok(packed.accessors.every(accessor => accessor.count >= 1));
    assert.equal(packed.meshes.length, 1);
    assert.equal(packed.nodes[0].mesh, 0);
    assert.equal(packed.nodes[1].mesh, undefined);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
