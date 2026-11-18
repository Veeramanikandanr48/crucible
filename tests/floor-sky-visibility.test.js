import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFloorSkyVisibility, findFloorParts } from '../src/floor-sky-visibility.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A flat square of side `size` at height `height`, facing up (or down), with UVs.
function square(name, size, height, { facing = 1, material = { color: [0.5, 0.5, 0.5] } } = {}) {
  const half = size / 2;
  const geometry = {
    positions: new Float32Array([-half, height, -half, half, height, -half, half, height, half, -half, height, half]),
    normals: new Float32Array([0, facing, 0, 0, facing, 0, 0, facing, 0, 0, facing, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array(facing > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]),
  };
  return { name, geometry, matrix: IDENTITY, material };
}

function skyVisibilityAt(result, floorIndex, x, z) {
  const { positions } = result.parts[floorIndex].geometry;
  const { skyVisibility } = result.parts[floorIndex].geometry;
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const distance = Math.hypot(positions[vertex * 3] - x, positions[vertex * 3 + 2] - z);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = vertex;
    }
  }
  return skyVisibility[nearest];
}

test('an open floor stays at full sky visibility', () => {
  const floor = square('floor', 20, 0);
  const result = applyFloorSkyVisibility([floor, square('far-away-roof', 2, 50, { facing: -1 })], { maximumTexels: 400 });
  assert.equal(result.report.reason, null);
  const values = result.parts[0].geometry.skyVisibility;
  assert.ok(values.length > 4, 'the floor is cut into texels');
  assert.ok(Math.min(...values) > 0.95, `the lowest value is ${Math.min(...values)}`);
});

test('a roof hides the sky under it and leaves the open side alone', () => {
  const floor = square('floor', 20, 0);
  const roof = square('roof', 6, 2, { facing: -1 });
  const result = applyFloorSkyVisibility([floor, roof], { maximumTexels: 1600 });
  const under = skyVisibilityAt(result, 0, 0, 0);
  const outside = skyVisibilityAt(result, 0, 9, 9);
  assert.ok(under < 0.5, `under the roof ${under}`);
  assert.ok(outside > 0.95, `outside ${outside}`);
});

test('strength 0.5 keeps half of what the roof hides', () => {
  const parts = [square('floor', 20, 0), square('roof', 6, 2, { facing: -1 })];
  const full = skyVisibilityAt(applyFloorSkyVisibility(parts, { maximumTexels: 1600 }), 0, 0, 0);
  const half = skyVisibilityAt(applyFloorSkyVisibility(parts, { maximumTexels: 1600, strength: 0.5 }), 0, 0, 0);
  assert.ok(Math.abs(half - (1 - (1 - full) / 2)) < 1e-6);
});

test('the cut floor keeps its UVs, normals and a shape that covers the same area', () => {
  const result = applyFloorSkyVisibility([square('floor', 10, 0), square('roof', 2, 3, { facing: -1 })], { maximumTexels: 200 });
  const { positions, uvs, normals, indices } = result.parts[0].geometry;
  assert.equal(uvs.length / 2, positions.length / 3);
  assert.equal(normals.length, positions.length);
  let area = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [0, 1, 2].map(slot => indices[corner + slot]);
    const edgeOne = [positions[second * 3] - positions[first * 3], positions[second * 3 + 2] - positions[first * 3 + 2]];
    const edgeTwo = [positions[third * 3] - positions[first * 3], positions[third * 3 + 2] - positions[first * 3 + 2]];
    area += Math.abs(edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]) / 2;
  }
  assert.ok(Math.abs(area - 100) < 1e-3, `area ${area}`);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    assert.ok(Math.abs(uvs[vertex * 2] - (positions[vertex * 3] / 10 + 0.5)) < 1e-5);
  }
});

test('the same parts give the same bytes', () => {
  const parts = [square('floor', 10, 0), square('roof', 4, 2, { facing: -1 })];
  const first = applyFloorSkyVisibility(parts, { maximumTexels: 300 }).parts[0].geometry.skyVisibility;
  const second = applyFloorSkyVisibility(parts, { maximumTexels: 300 }).parts[0].geometry.skyVisibility;
  assert.deepEqual(Array.from(first), Array.from(second));
});

test('parts that carry their own light, a cut-out or a tag are not floors', () => {
  const baked = square('baked', 10, 0, { material: { color: [1, 1, 1], lightMap: {} } });
  const leaves = square('leaves', 10, 0, { material: { color: [1, 1, 1], alphaMode: 'mask' } });
  const water = square('water', 10, 0, { material: { color: [1, 1, 1], tag: 'water' } });
  const own = square('own', 10, 0);
  own.geometry.skyVisibility = new Float32Array(4).fill(1);
  const roof = square('roof', 4, 2, { facing: -1 });
  assert.deepEqual(findFloorParts([baked, leaves, water, own, roof]), []);
});

test('onlyClosedRooms leaves an open scene as it was', () => {
  const parts = [square('floor', 20, 0), square('roof', 6, 2, { facing: -1 })];
  const result = applyFloorSkyVisibility(parts, { onlyClosedRooms: true });
  assert.equal(result.parts, parts);
  assert.equal(result.report.reason, 'open scene');
});

test('a scene with no floor or nothing above it comes back unchanged', () => {
  const lone = [square('floor', 10, 0)];
  assert.equal(applyFloorSkyVisibility(lone).parts, lone);
  assert.equal(applyFloorSkyVisibility(lone).report.reason, 'nothing above the floor');
  const roofOnly = [square('roof', 4, 2, { facing: -1 }), square('roof-two', 4, 3, { facing: -1 })];
  assert.equal(applyFloorSkyVisibility(roofOnly).report.reason, 'no floor');
});

test('a trace that passes its time limit returns the parts as they were', () => {
  const parts = [square('floor', 10, 0), square('roof', 4, 2, { facing: -1 })];
  const result = applyFloorSkyVisibility(parts, { maxSeconds: 0 });
  assert.equal(result.parts, parts);
  assert.equal(result.report.reason, 'passed maxSeconds');
});

// A box of unit size with flat faces, six faces of four vertices each, scaled and moved by its matrix.
function boxPart(name, [x, y, z], [width, height, depth]) {
  const faces = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]];
  const positions = [];
  const normals = [];
  const indices = [];
  for (const [normal, tangent, bitangent] of faces) {
    const first = positions.length / 3;
    for (const [along, across] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...[0, 1, 2].map(axis => 0.5 * (normal[axis] + along * tangent[axis] + across * bitangent[axis])));
      normals.push(...normal);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  const matrix = [width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1];
  const geometry = { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
  return { name, geometry, matrix, material: { color: [0.7, 0.7, 0.7] } };
}

// The window room of the interior exposure probe (#1334): walls of 0.2 m that overlap at the corners, a window only in the front wall.
function windowRoomParts() {
  return [
    boxPart('floor', [0, -0.1, 0.25], [8.4, 0.2, 6.9]),
    boxPart('ceiling', [0, 3.1, 0.25], [8.4, 0.2, 6.9]),
    boxPart('wall-left', [-4.1, 1.5, 0.25], [0.2, 3, 6.9]),
    boxPart('wall-right', [4.1, 1.5, 0.25], [0.2, 3, 6.9]),
    boxPart('wall-back', [0, 1.5, 3.6], [8, 3, 0.2]),
    boxPart('front-left', [-2.7, 1.5, -3.1], [2.6, 3, 0.2]),
    boxPart('front-right', [2.7, 1.5, -3.1], [2.6, 3, 0.2]),
    boxPart('front-sill', [0, 0.45, -3.1], [2.8, 0.9, 0.2]),
    boxPart('front-head', [0, 2.7, -3.1], [2.8, 0.6, 0.2]),
  ];
}

// The brightest sky visibility among the vertices of one face of a part whose world depth is at least `minimumDepth`: the half of the room away from the window.
function brightestRoomSide(result, partName, normalAxis, normalSign, minimumDepth = 2) {
  const part = result.parts.find(candidate => candidate.name === partName);
  const { positions, normals, skyVisibility } = part.geometry;
  const { matrix } = part;
  let brightest = 0;
  for (let vertex = 0; vertex < skyVisibility.length; vertex++) {
    const depth = matrix[2] * positions[vertex * 3] + matrix[6] * positions[vertex * 3 + 1] + matrix[10] * positions[vertex * 3 + 2] + matrix[14];
    if (depth >= minimumDepth && normals[vertex * 3 + normalAxis] * normalSign > 0.9) brightest = Math.max(brightest, skyVisibility[vertex]);
  }
  return brightest;
}

test('walls that run into the back wall do not glow near its corners: their buried end vertices read as occluded (#2166)', () => {
  const result = applyFloorSkyVisibility(windowRoomParts(), { onlyClosedRooms: true, surfaces: 'all' });
  assert.equal(result.report.reason, null);
  // The far half of the room sees the sky only through a 2.8 x 1.5 m window at least 5 m away, so these inner faces stay dark:
  // no brighter than the interior fill every point of the room gets (#1334) plus 0.1.
  const darkest = result.report.interiorFill + 0.1;
  assert.ok(brightestRoomSide(result, 'wall-left', 0, 1) < darkest, 'left wall inner face');
  assert.ok(brightestRoomSide(result, 'wall-right', 0, -1) < darkest, 'right wall inner face');
  assert.ok(brightestRoomSide(result, 'ceiling', 1, -1) < darkest, 'ceiling underside');
  assert.ok(brightestRoomSide(result, 'wall-back', 2, -1) < darkest, 'back wall inner face');
});
