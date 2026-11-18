import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { CLOUD_LIMITS, checkFaceCount } from '../src/cloud-geometry.js';
import { growLevels, levelSettings, levelUnion, levelUnionByBruteForce } from '../src/cloud-levels.js';
import { seededRandom } from '../src/seeded-random.js';
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

const TOWER_LEVELS = [{ count: 7, sizeRatio: 1 }, { count: 60, sizeRatio: 0.35 }, { count: 680, sizeRatio: 0.12 }];

test('a cloud without levels keeps the bytes it had before levels existed', () => {
  assert.equal(hashOf(cloudGeometry({ seed: 7, puffs: 12 })), 'c5df2864c435732ada8ae8f7d6e9ccd77dc8aca16a4a1eaa452edb80de81cad1');
});

test('a tower of levels is deterministic, closed, one piece and sized as asked', () => {
  const tower = cloudGeometry({ seed: 3, levels: TOWER_LEVELS, resolution: 64, width: 8, height: 6 });
  assert.equal(hashOf(cloudGeometry({ seed: 3, levels: TOWER_LEVELS, resolution: 64, width: 8, height: 6 })), hashOf(tower));
  assert.notEqual(hashOf(cloudGeometry({ seed: 4, levels: TOWER_LEVELS, resolution: 64, width: 8, height: 6 })), hashOf(tower));
  assert.notEqual(hashOf(cloudGeometry({ seed: 3, levels: TOWER_LEVELS.slice(0, 2), resolution: 64, width: 8, height: 6 })), hashOf(tower));
  assert.equal(openEdgeCount(tower), 0);
  assert.equal(pieceCount(tower), 1);
  const { low, high } = boundsOf(tower);
  assert.ok(Math.max(high[0] - low[0], high[2] - low[2]) > 8 * 0.95 && Math.max(high[0] - low[0], high[2] - low[2]) < 8 * 1.05);
  assert.ok(Math.abs(low[1]) < 0.1);
});

test('the grid gives the same union as checking every lobe, wherever the surface can be', () => {
  const baseLobes = [{ center: [0, 0, 0], radius: 1 }, { center: [1.2, 0.3, 0], radius: 0.8 }, { center: [-0.8, 0.9, 0.4], radius: 0.7 }];
  const grown = growLevels(baseLobes, levelSettings(TOWER_LEVELS), { seed: 5, upBias: 0.5 });
  const levels = grown.map(lobes => ({ lobes, blend: 0.3 * Math.max(...lobes.map(lobe => lobe.radius)) }));
  const fast = levelUnion(levels);
  const slow = levelUnionByBruteForce(levels);
  let compared = 0;
  for (let sample = 0; sample < 4000; sample++) {
    const point = [0, 1, 2].map(axis => (seededRandom(sample, axis, 9) - 0.5) * 5);
    const reference = slow(...point);
    if (Math.abs(reference) > 0.1) continue;
    compared++;
    assert.ok(Math.abs(fast(...point) - reference) < 1e-9, `sample ${sample} differs`);
  }
  assert.ok(compared > 100, `only ${compared} samples near the surface`);
});

test('grown lobes sit on their parents and upBias 1 never grows them downward', () => {
  const baseLobes = [{ center: [0, 0, 0], radius: 1 }];
  const levels = levelSettings([{ count: 1, sizeRatio: 1 }, { count: 50, sizeRatio: 0.3 }]);
  const lifted = growLevels(baseLobes, levels, { seed: 2, upBias: 1 })[1];
  const uniform = growLevels(baseLobes, levels, { seed: 2, upBias: 0 })[1];
  assert.ok(lifted.every(lobe => lobe.center[1] >= -1e-12));
  assert.ok(uniform.some(lobe => lobe.center[1] < -0.2));
  for (const lobe of uniform) assert.ok(Math.hypot(...lobe.center) < 1 && Math.hypot(...lobe.center) > 1 - 0.3 * lobe.radius - 1e-9);
});

test('normals come from the field gradient: unit length and facing along the face they belong to', () => {
  const mesh = cloudGeometry({ seed: 2, levels: TOWER_LEVELS, resolution: 48 });
  let alignment = 0;
  let pairs = 0;
  let facingAway = 0;
  for (let corner = 0; corner < mesh.indices.length; corner += 3) {
    const [first, second, third] = [0, 1, 2].map(side => mesh.indices[corner + side]);
    const point = vertex => [0, 1, 2].map(axis => mesh.positions[vertex * 3 + axis]);
    const [firstPoint, secondPoint, thirdPoint] = [first, second, third].map(point);
    const edgeOne = secondPoint.map((value, axis) => value - firstPoint[axis]);
    const edgeTwo = thirdPoint.map((value, axis) => value - firstPoint[axis]);
    const face = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
    const faceLength = Math.hypot(...face);
    if (faceLength < 1e-9) continue;
    for (const vertex of [first, second, third]) {
      const normal = [0, 1, 2].map(axis => mesh.normals[vertex * 3 + axis]);
      assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-4);
      alignment += (normal[0] * face[0] + normal[1] * face[1] + normal[2] * face[2]) / faceLength;
      pairs++;
      if ((normal[0] * face[0] + normal[1] * face[1] + normal[2] * face[2]) < 0) facingAway++;
    }
  }
  assert.ok(alignment / pairs > 0.8, `normals follow their faces on average: ${alignment / pairs}`);
  assert.ok(facingAway / pairs < 0.01, `${facingAway} of ${pairs} corners face away from their triangle`);
});

test('levels, upBias, unionSoftness and size limits name the field and what to pass', () => {
  assert.throws(() => cloudGeometry({ levels: [] }), /cloud\.levels.*1 to 4 levels/);
  assert.throws(() => cloudGeometry({ levels: 'many' }), /cloud\.levels.*array/);
  assert.throws(() => cloudGeometry({ levels: Array(5).fill({ count: 2, sizeRatio: 0.5 }) }), /cloud\.levels.*1 to 4 levels/);
  assert.throws(() => cloudGeometry({ levels: [{ count: 49, sizeRatio: 1 }] }), /cloud\.levels\[0\]\.count.*1 to 48/);
  assert.throws(() => cloudGeometry({ levels: [{ count: 7, sizeRatio: 1 }, { count: 1001, sizeRatio: 0.3 }] }), /cloud\.levels\[1\]\.count.*1 to 1000/);
  assert.throws(() => cloudGeometry({ levels: [{ count: 40, sizeRatio: 1 }, { count: 600, sizeRatio: 0.3 }, { count: 600, sizeRatio: 0.1 }] }), /at most 1000 lobes in all/);
  assert.throws(() => cloudGeometry({ levels: [{ count: 7, sizeRatio: 5 }] }), /cloud\.levels\[0\]\.sizeRatio/);
  assert.throws(() => cloudGeometry({ levels: [{ count: 7, sizeRatio: 1, size: 2 }] }), /cloud\.levels\[0\]\.size.*remove "size"/);
  assert.throws(() => cloudGeometry({ levels: TOWER_LEVELS, puffs: 10 }), /cloud\.puffs.*remove puffs/);
  assert.throws(() => cloudGeometry({ upBias: 0.5 }), /cloud\.upBias.*add levels/);
  assert.throws(() => cloudGeometry({ levels: TOWER_LEVELS, upBias: 2 }), /cloud\.upBias.*0 to 1/);
  assert.throws(() => cloudGeometry({ unionSoftness: 0 }), /cloud\.unionSoftness.*0\.02 to 1/);
  assert.throws(() => cloudGeometry({ levels: TOWER_LEVELS, resolution: 161 }), /cloud\.resolution.*16 to 160/);
  assert.throws(() => cloudGeometry({ levels: TOWER_LEVELS, resolution: 160 }, 1000), /exceeding maxVertices 1000/);
});

test('a mesh over the face limit says which resolution to pass', () => {
  assert.throws(() => checkFaceCount({ indices: new Uint32Array(3 * 200_000) }, 160), /makes 200000 faces, over the limit of 150000\. Pass resolution 138 or lower/);
  checkFaceCount({ indices: new Uint32Array(3 * 150_000) }, 160);
});

test('unionSoftness widens the blend between lobes of a cloud without levels', () => {
  assert.notEqual(hashOf(cloudGeometry({ seed: 7, puffs: 12, unionSoftness: 0.5 })), hashOf(cloudGeometry({ seed: 7, puffs: 12 })));
});

test('a recipe cloud with levels becomes a part', () => {
  const scene = createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'white', color: [0.95, 0.95, 0.97], roughness: 1 }],
    geometries: [{ id: 'cloud', type: 'cloud', seed: 4, levels: TOWER_LEVELS, resolution: 40 }],
    nodes: [{ id: 'cloud-node', geometry: 'cloud', material: 'white' }],
  });
  assert.equal(hashOf(scene.parts[0].geometry), hashOf(cloudGeometry({ seed: 4, levels: TOWER_LEVELS, resolution: 40 })));
});
