import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshData, applyMeshEdits } from '../src/mesh.js';
import { vertexGroupWeights, VECTOR_PREFIX } from '../src/mesh-data.js';
import { createAgentScene } from '../src/agent-scene.js';
import { extractRender } from '../src/mesh-render.js';
import { createMeshSource } from '../src/particle-emitter-mesh.js';

const SEA = { op: 'ocean', seed: 3, windSpeed: 12, size: 2, resolution: 4, choppiness: 2, time: 1.5 };

function flatGrid(cells, extent) {
  const columns = cells + 1;
  const positions = new Float32Array(columns * columns * 3);
  for (let row = 0; row < columns; row++) {
    for (let column = 0; column < columns; column++) {
      positions.set([(column / cells - 0.5) * extent, 0, (row / cells - 0.5) * extent], (row * columns + column) * 3);
    }
  }
  const faceOffsets = new Uint32Array(cells * cells + 1);
  const cornerVertices = new Uint32Array(cells * cells * 4);
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const face = row * cells + column;
      const corner = row * columns + column;
      faceOffsets[face + 1] = (face + 1) * 4;
      cornerVertices.set([corner, corner + 1, corner + columns + 1, corner + columns], face * 4);
    }
  }
  return createMeshData({ positions, faceOffsets, cornerVertices });
}

function sprayVectors(mesh) {
  return mesh.attributes.point[`${VECTOR_PREFIX}spray`].data;
}

test('spray is opt-in: without it the ocean writes only foam', () => {
  const mesh = applyMeshEdits(flatGrid(16, 4), [SEA]).mesh;
  assert.deepEqual(Object.keys(mesh.attributes.point).sort(), ['group:foam']);
});

test('spray weighs foamy points where the surface rises, and its velocity is the real surface velocity', () => {
  const grid = flatGrid(24, 4);
  const sprayed = applyMeshEdits(grid, [{ ...SEA, spray: true }]).mesh;
  const foam = vertexGroupWeights(sprayed, 'foam');
  const spray = vertexGroupWeights(sprayed, 'spray');
  const velocity = sprayVectors(sprayed);
  let sprayVertices = 0;
  for (let vertex = 0; vertex < sprayed.vertexCount; vertex++) {
    assert.ok(spray[vertex] >= 0 && spray[vertex] <= foam[vertex] + 1e-6, 'spray is never above foam');
    if (spray[vertex] > 0) {
      sprayVertices++;
      assert.ok(velocity[vertex * 3 + 1] > 0, 'a point that sprays is rising');
    }
  }
  assert.ok(sprayVertices > 5, `a rough sea sprays at ${sprayVertices} vertices`);
  assert.ok(sprayVertices < sprayed.vertexCount, 'not every point sprays');
  // The rise speed is the time derivative of the height: a small step in time agrees with it.
  const step = 1e-3;
  const later = applyMeshEdits(grid, [{ ...SEA, spray: true, time: SEA.time + step }]).mesh;
  let compared = 0;
  for (let vertex = 0; vertex < sprayed.vertexCount; vertex++) {
    if (spray[vertex] === 0) continue;
    const measured = (later.positions[vertex * 3 + 1] - sprayed.positions[vertex * 3 + 1]) / step;
    assert.ok(Math.abs(measured - velocity[vertex * 3 + 1]) < 0.02 * Math.max(1, Math.abs(measured)), `rise ${velocity[vertex * 3 + 1]} against measured ${measured}`);
    compared++;
  }
  assert.ok(compared > 5);
});

test('the same seed gives the same spray, and a wrong spray value says what to pass', () => {
  const first = applyMeshEdits(flatGrid(12, 4), [{ ...SEA, spray: true }]).mesh;
  const second = applyMeshEdits(flatGrid(12, 4), [{ ...SEA, spray: true }]).mesh;
  assert.deepEqual(Array.from(sprayVectors(first)), Array.from(sprayVectors(second)));
  assert.deepEqual(Array.from(vertexGroupWeights(first, 'spray')), Array.from(vertexGroupWeights(second, 'spray')));
  assert.throws(() => applyMeshEdits(flatGrid(4, 4), [{ ...SEA, spray: 'yes' }]), /spray must be true or false/);
});

function seaRecipe(emitter, system = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'subdivide', levels: 3 }, { ...SEA, spray: true }] },
      { id: 'drop', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'water' }],
    nodes: [
      { id: 'surface', geometry: 'sea', material: 'water' },
      { id: 'droplets', geometry: 'drop', material: 'water' },
    ],
    particles: { gravity: [0, 0, 0], systems: [{ node: 'droplets', seed: 5, count: 60, speed: 0, spread: 0, size: 0.001, lifetime: 5, emitter: { shape: 'mesh', mesh: 'surface', group: 'spray', ...emitter }, ...system }] },
  };
}

function dropletCentres(emitter, time) {
  const scene = createAgentScene(seaRecipe(emitter));
  scene.sampleMotion(time);
  const geometry = scene.parts.find(part => part.name === 'droplets').geometry;
  const verticesPerDrop = 24;
  const centres = [];
  for (let first = 0; first < geometry.positions.length / 3; first += verticesPerDrop) {
    const centre = [0, 0, 0];
    for (let vertex = first; vertex < first + verticesPerDrop; vertex++) {
      for (let axis = 0; axis < 3; axis++) centre[axis] += geometry.positions[vertex * 3 + axis] / verticesPerDrop;
    }
    centres.push(centre);
  }
  return centres;
}

test('spray droplets leave with the sea velocity, scaled by velocityScale, and the same bytes each run', () => {
  const unscaled = [dropletCentres({ from: 'vertices', velocityFrom: 'spray' }, 0), dropletCentres({ from: 'vertices', velocityFrom: 'spray' }, 1)];
  const doubled = [dropletCentres({ from: 'vertices', velocityFrom: 'spray', velocityScale: 2 }, 0), dropletCentres({ from: 'vertices', velocityFrom: 'spray', velocityScale: 2 }, 1)];
  const still = [dropletCentres({ from: 'vertices' }, 0), dropletCentres({ from: 'vertices' }, 1)];
  assert.equal(unscaled[0].length, 60);
  let rising = 0;
  unscaled[0].forEach((start, index) => {
    const lift = unscaled[1][index][1] - start[1];
    if (lift > 1e-3) rising++;
    assert.ok(Math.abs((doubled[1][index][1] - doubled[0][index][1]) - 2 * lift) < 1e-6, 'velocityScale 2 doubles the travel');
    assert.ok(Math.abs(still[1][index][1] - still[0][index][1]) < 1e-9, 'without velocityFrom the droplets stay put');
  });
  assert.equal(rising, 60, 'every droplet born at a spray vertex rises and travels up');
  assert.deepEqual(dropletCentres({ from: 'vertices', velocityFrom: 'spray' }, 1), unscaled[1]);
});

test('velocityFrom names a vector that exists and a surface or vertices emitter', () => {
  const failure = (emitter, pattern) => assert.throws(() => createAgentScene(seaRecipe(emitter)), pattern);
  failure({ velocityFrom: 'swell' }, /emitter\.velocityFrom[\s\S]*known vectors: spray/);
  failure({ velocityFrom: '' }, /emitter\.velocityFrom[\s\S]*name of a vector/);
  failure({ velocityFrom: 'spray', from: 'edges' }, /emitter\.velocityFrom[\s\S]*"surface" or "vertices"/);
  failure({ velocityScale: 2 }, /emitter\.velocityScale[\s\S]*velocityFrom/);
  failure({ velocityFrom: 'spray', velocityScale: 5000 }, /emitter\.velocityScale/);
  assert.throws(() => createAgentScene({ ...seaRecipe({}), particles: { systems: [{ node: 'droplets', emitter: { shape: 'point', velocityFrom: 'spray' } }] } }), /emitter\.velocityFrom[\s\S]*shape is "mesh"/);
});

test('a surface sample interpolates the vertex vectors across its triangle', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const vectors = new Float32Array([0, 0, 0, 3, 0, 0, 0, 0, 3]);
  const source = createMeshSource(positions, normals, new Uint32Array([0, 1, 2]), 'surface', null, null, vectors);
  let state = 12345;
  const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let draw = 0; draw < 20; draw++) {
    const { point, velocity } = source.sample(random);
    assert.ok(Math.abs(velocity[0] - 3 * point[0]) < 1e-9 && Math.abs(velocity[2] - 3 * point[2]) < 1e-9, 'the vector grows with the point toward its corner');
  }
});

// Spawn points of a surface emitter over a rough sea, split by the spray weight at the point.
function sprayWeightsOfSpawns(threshold) {
  const grid = flatGrid(24, 4);
  const sea = applyMeshEdits(grid, [{ ...SEA, spray: true }]).mesh;
  const { geometry } = extractRender(sea);
  const source = createMeshSource(geometry.positions, geometry.normals, geometry.indices, 'surface', geometry.vertexGroups.spray, null, geometry.vertexVectors.spray, threshold);
  let state = 777;
  const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  return Array.from({ length: 1500 }, () => source.sample(random).weight);
}

test('a group threshold keeps spawn points off the weakly sprayed water', () => {
  const faint = weights => weights.filter(weight => weight < 0.3).length;
  const without = sprayWeightsOfSpawns(0);
  const withThreshold = sprayWeightsOfSpawns(0.3);
  assert.ok(faint(without) > 150, `${faint(without)} of 1500 spawn points sit under spray weight 0.3 without a threshold`);
  assert.equal(faint(withThreshold), 0, 'no spawn point under the threshold');
  assert.ok(withThreshold.every(weight => weight >= 0.3));
});

test('groupThreshold needs a group and stays between 0 and 1', () => {
  const failure = (emitter, pattern) => assert.throws(() => createAgentScene(seaRecipe(emitter)), pattern);
  const ungrouped = seaRecipe({ groupThreshold: 0.3 });
  delete ungrouped.particles.systems[0].emitter.group;
  assert.throws(() => createAgentScene(ungrouped), /emitter.groupThreshold[^]*group/);
  failure({ groupThreshold: 2 }, /emitter\.groupThreshold/);
});

// A sea driven by an oceanTime track: droplets born at time t start on the water that sprays at t.
function movingSeaRecipe() {
  const recipe = seaRecipe({ groupThreshold: 0.3 }, { count: 120, rate: 60, lifetime: 0.5, size: 0.01 });
  const sea = { ...SEA, time: 0, size: 8, resolution: 8, windSpeed: 14, choppiness: 2, spray: true };
  recipe.geometries[0] = { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 4 }, sea] };
  recipe.motion = { duration: 2, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 2 }] }] };
  return recipe;
}

function birthsOnSprayingWater(recipe) {
  const scene = createAgentScene(recipe);
  const counts = { early: 0, late: 0 };
  for (let index = 0; index < 120; index++) {
    const birth = index / 60;
    scene.sampleMotion(birth);
    const sea = scene.parts.find(part => part.name === 'surface').geometry;
    const drops = scene.parts.find(part => part.name === 'droplets').geometry;
    const centre = [0, 1, 2].map(axis => {
      let sum = 0;
      for (let vertex = index * 24; vertex < index * 24 + 24; vertex++) sum += drops.positions[vertex * 3 + axis];
      return sum / 24;
    });
    let nearest = Infinity;
    let nearestWeight = 0;
    for (let vertex = 0; vertex < sea.positions.length / 3; vertex++) {
      const distance = Math.hypot(sea.positions[vertex * 3] - centre[0], sea.positions[vertex * 3 + 1] - centre[1], sea.positions[vertex * 3 + 2] - centre[2]);
      if (distance < nearest) {
        nearest = distance;
        nearestWeight = sea.vertexGroups.spray[vertex];
      }
    }
    if (nearest <= 0.3 && nearestWeight >= 0.3) counts[birth < 1 ? 'early' : 'late']++;
  }
  return counts;
}

test('droplets born later start on the crests that have arrived by then, and the same seed gives the same bytes', () => {
  const counts = birthsOnSprayingWater(movingSeaRecipe());
  assert.ok(counts.early > 20, `${counts.early} of 60 droplets born in the first second start on spraying water`);
  assert.ok(counts.late > 20, `${counts.late} of 60 droplets born in the second second start on spraying water`);
  const first = createAgentScene(movingSeaRecipe());
  const second = createAgentScene(movingSeaRecipe());
  first.sampleMotion(1.5);
  second.sampleMotion(1.5);
  assert.deepEqual(Array.from(first.parts.find(part => part.name === 'droplets').geometry.positions), Array.from(second.parts.find(part => part.name === 'droplets').geometry.positions));
});
