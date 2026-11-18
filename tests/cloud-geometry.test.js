import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { CLOUD_LIMITS } from '../src/cloud-geometry.js';
import { cloudGeometry, cloudVertexEstimate } from '../src/modeling.js';

function hashOf(mesh) {
  const hash = createHash('sha256');
  for (const array of [mesh.positions, mesh.normals, mesh.uvs, mesh.indices]) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest('hex');
}

function boundsOf({ positions }) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], positions[offset + axis]);
      high[axis] = Math.max(high[axis], positions[offset + axis]);
    }
  }
  return { low, high };
}

// Edges that do not belong to exactly two triangles; zero means the surface is closed.
function openEdgeCount({ indices }) {
  const uses = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const from = indices[offset + side];
      const to = indices[offset + (side + 1) % 3];
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter(count => count !== 2).length;
}

function pieceCount({ positions, indices }) {
  const parent = Array.from({ length: positions.length / 3 }, (_, index) => index);
  const root = vertex => {
    while (parent[vertex] !== vertex) vertex = parent[vertex] = parent[parent[vertex]];
    return vertex;
  };
  for (let offset = 0; offset < indices.length; offset += 3) {
    parent[root(indices[offset + 1])] = root(indices[offset]);
    parent[root(indices[offset + 2])] = root(indices[offset]);
  }
  return new Set(Array.from(new Set(indices), vertex => root(vertex))).size;
}

test('the same seed gives the same bytes and another seed gives another cloud', () => {
  const first = cloudGeometry({ seed: 7, puffs: 12 });
  assert.equal(hashOf(cloudGeometry({ seed: 7, puffs: 12 })), hashOf(first));
  assert.notEqual(hashOf(cloudGeometry({ seed: 8, puffs: 12 })), hashOf(first));
});

test('a cloud is one closed surface with outward normals and a flat base on y = 0', () => {
  for (const seed of [1, 2, 3, 4]) {
    const mesh = cloudGeometry({ seed, puffs: 16, flatBase: 0.7 });
    assert.equal(openEdgeCount(mesh), 0, `seed ${seed} has open edges`);
    assert.equal(pieceCount(mesh), 1, `seed ${seed} splits into several pieces`);
    assert.ok(Math.abs(boundsOf(mesh).low[1]) < 0.05, `seed ${seed} base is off y = 0`);
    const normalLength = Math.hypot(mesh.normals[0], mesh.normals[1], mesh.normals[2]);
    assert.ok(Math.abs(normalLength - 1) < 1e-4);
  }
});

test('width and height size the cloud and flatBase flattens its underside', () => {
  const round = cloudGeometry({ seed: 5, width: 20, height: 8, flatBase: 0 });
  const flat = cloudGeometry({ seed: 5, width: 20, height: 8, flatBase: 1 });
  const { low, high } = boundsOf(round);
  assert.ok(Math.max(high[0] - low[0], high[2] - low[2]) > 20 * 0.97 && Math.max(high[0] - low[0], high[2] - low[2]) < 20 * 1.03);
  assert.ok(high[1] - low[1] > 8 * 0.97 && high[1] - low[1] < 8 * 1.03);
  const flatBase = boundsOf(flat);
  assert.ok(flatBase.high[1] < high[1], 'a flatter base cuts height off the underside');
  const underside = mesh => Array.from({ length: mesh.positions.length / 3 }, (_, vertex) => mesh.positions[vertex * 3 + 1]).filter(y => y < 0.3).length;
  assert.ok(underside(flat) > underside(round) * 2, 'flatBase puts many more vertices on the base plane');
});

test('more puffs make a lumpier, larger-surface cloud within the vertex estimate', () => {
  const few = cloudGeometry({ seed: 9, puffs: 3 });
  const many = cloudGeometry({ seed: 9, puffs: 30 });
  assert.notEqual(hashOf(few), hashOf(many));
  assert.ok(many.positions.length / 3 <= cloudVertexEstimate({ resolution: CLOUD_LIMITS.defaults.resolution }));
});

test('bad values name the field and what to pass', () => {
  assert.throws(() => cloudGeometry({ puffs: 1 }), /cloud\.puffs: got 1; expected a whole number from 2 to 48, such as 14/);
  assert.throws(() => cloudGeometry({ puffs: 2.5 }), /cloud\.puffs.*whole number/);
  assert.throws(() => cloudGeometry({ width: 0 }), /cloud\.width.*0\.5 to 2000/);
  assert.throws(() => cloudGeometry({ height: Number.NaN }), /cloud\.height/);
  assert.throws(() => cloudGeometry({ flatBase: 1.5 }), /cloud\.flatBase.*0 to 1/);
  assert.throws(() => cloudGeometry({ resolution: 200 }), /cloud\.resolution.*16 to 96/);
  assert.throws(() => cloudGeometry({ seed: -1 }), /cloud\.seed/);
  assert.throws(() => cloudGeometry({ colour: 'white' }), /cloud\.colour.*remove "colour"/);
  assert.throws(() => cloudGeometry({ resolution: 96 }, 1000), /exceeding maxVertices 1000/);
});

test('a recipe cloud geometry becomes a part and respects the vertex budget', () => {
  const recipe = (geometry, limits) => createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'white', color: [0.95, 0.95, 0.97], roughness: 1 }],
    geometries: [{ id: 'cloud', type: 'cloud', ...geometry }],
    nodes: [{ id: 'cloud-node', geometry: 'cloud', material: 'white' }],
  }, limits);
  const scene = recipe({ seed: 11, puffs: 10, resolution: 32 });
  assert.equal(hashOf(scene.parts[0].geometry), hashOf(cloudGeometry({ seed: 11, puffs: 10, resolution: 32 })));
  assert.throws(() => recipe({ resolution: 96 }, { maxVertices: 1000 }), /vertices|maxVertices/);
  assert.throws(() => recipe({ puffs: 100 }), /cloud\.puffs/);
  assert.throws(() => recipe({ puffs: null }), /puffs/);
  assert.throws(() => recipe({ radius: 3 }), /radius/);
});
