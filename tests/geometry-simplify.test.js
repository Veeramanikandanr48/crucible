// Attribute-keeping edge collapse and the dense-scene level helper (#1163).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sphere } from '../src/geometry.js';
import { simplifyGeometry, findLockedVertices, MAXIMUM_SIMPLIFY_TRIANGLES } from '../src/geometry-simplify.js';
import { generateGeometryLods } from '../src/mesh-lod.js';
import { addLodsToDenseParts, trianglesPerPixel, DEFAULT_MINIMUM_TRIANGLES } from '../src/dense-lods.js';

// A flat grid in the xy plane whose uv is (x, y) and whose colour is a function of the vertex, so a surviving
// vertex proves it kept its own attributes.
function uvGrid(cells) {
  const side = cells + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);
  const colors = new Float32Array(side * side * 3);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const vertex = row * side + column;
      positions.set([column / cells, row / cells, 0], vertex * 3);
      normals.set([0, 0, 1], vertex * 3);
      uvs.set([column / cells, row / cells], vertex * 2);
      colors.set([column / cells, row / cells, 0.5], vertex * 3);
    }
  }
  const indices = [];
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const corner = row * side + column;
      indices.push(corner, corner + 1, corner + side, corner + 1, corner + side + 1, corner + side);
    }
  }
  return { positions, normals, uvs, colors, indices: Uint32Array.from(indices) };
}

test('a reduced grid keeps the uv and colour of every vertex that survives', () => {
  const grid = uvGrid(24);
  const [level] = simplifyGeometry(grid, { ratios: [0.25] });
  assert.ok(level.geometry.indices.length / 3 <= grid.indices.length / 3 * 0.25 + 2);
  const vertexCount = level.geometry.positions.length / 3;
  assert.equal(level.geometry.uvs.length, vertexCount * 2);
  assert.equal(level.geometry.colors.length, vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const [x, y] = level.geometry.positions.subarray(vertex * 3, vertex * 3 + 2);
    assert.deepEqual([...level.geometry.uvs.subarray(vertex * 2, vertex * 2 + 2)], [x, y]);
    assert.deepEqual([...level.geometry.colors.subarray(vertex * 3, vertex * 3 + 3)], [x, y, 0.5].map(Math.fround));
  }
});

test('the border of the grid stays where it was and a flat grid reduces with no error', () => {
  const grid = uvGrid(24);
  const [level] = simplifyGeometry(grid, { ratios: [0.1] });
  const border = new Set();
  for (let vertex = 0; vertex < level.geometry.positions.length / 3; vertex++) {
    const [x, y] = level.geometry.positions.subarray(vertex * 3, vertex * 3 + 2);
    if (x === 0 || y === 0 || x === 1 || y === 1) border.add(`${x},${y}`);
  }
  assert.equal(border.size, 24 * 4, 'every border vertex survives');
  assert.ok(level.error < 1e-6);
});

test('levels keep the seam of a sphere and report a growing error', () => {
  const geometry = sphere(48, 24);
  const levels = simplifyGeometry(geometry, { ratios: [0.5, 0.25] });
  assert.ok(levels[0].error > 0);
  assert.ok(levels[1].error >= levels[0].error);
  assert.ok(levels[1].triangles < levels[0].triangles);
  const locked = findLockedVertices(geometry.indices, geometry.positions.length / 3);
  const seamPositions = new Set();
  for (let vertex = 0; vertex < locked.length; vertex++) if (locked[vertex]) seamPositions.add([...geometry.positions.subarray(vertex * 3, vertex * 3 + 3)].join(','));
  const survivors = new Set();
  const finalGeometry = levels[1].geometry;
  for (let vertex = 0; vertex < finalGeometry.positions.length / 3; vertex++) survivors.add([...finalGeometry.positions.subarray(vertex * 3, vertex * 3 + 3)].join(','));
  for (const position of seamPositions) assert.ok(survivors.has(position), `seam vertex ${position} survives`);
});

function withAllAttributes(geometry) {
  const vertexCount = geometry.positions.length / 3;
  const lightUvs = new Float32Array(vertexCount * 2).map((value, index) => (index * 7919 % 1000) / 1000);
  const skyVisibility = new Float32Array(vertexCount).map((value, index) => (index % 10) / 10);
  const colors = new Float32Array(vertexCount * 3).map((value, index) => (index % 13) / 13);
  return { ...geometry, lightUvs, skyVisibility, colors };
}

test('the same input gives the same levels, byte for byte, in every attribute', () => {
  const first = simplifyGeometry(withAllAttributes(sphere(32, 16)), { ratios: [0.5, 0.3] });
  const second = simplifyGeometry(withAllAttributes(sphere(32, 16)), { ratios: [0.5, 0.3] });
  first.forEach((level, index) => {
    for (const field of ['positions', 'normals', 'uvs', 'colors', 'lightUvs', 'skyVisibility', 'indices']) {
      assert.ok(level.geometry[field], `level ${index} has ${field}`);
      assert.deepEqual(Buffer.from(level.geometry[field].buffer), Buffer.from(second[index].geometry[field].buffer), field);
    }
    assert.equal(level.error, second[index].error);
  });
});

test('error is a distance: scaling the mesh by k scales the error by k', () => {
  const geometry = sphere(48, 24);
  const base = simplifyGeometry(geometry, { ratios: [0.3] })[0];
  for (const factor of [0.125, 4, 256]) {
    const scaled = { ...geometry, positions: geometry.positions.map(value => value * factor) };
    const level = simplifyGeometry(scaled, { ratios: [0.3] })[0];
    assert.equal(level.triangles, base.triangles);
    assert.ok(Math.abs(level.error / (base.error * factor) - 1) < 1e-3, `scale ${factor}: ${level.error} against ${base.error * factor}`);
  }
});

test('a UV seam on a flat grid stays locked and keeps its uvs on both sides', () => {
  // Two grids side by side share the column x = 1 but not its vertices: the uvs jump there.
  const left = uvGrid(12);
  const right = uvGrid(12);
  const count = left.positions.length / 3;
  const positions = new Float32Array(count * 6);
  positions.set(left.positions);
  positions.set(right.positions.map((value, index) => (index % 3 === 0 ? value + 1 : value)), count * 3);
  const uvs = new Float32Array(count * 4);
  uvs.set(left.uvs);
  uvs.set(right.uvs.map(value => value * 0.5 + 7), count * 2);
  const normals = new Float32Array(count * 6).map((value, index) => (index % 3 === 2 ? 1 : 0));
  const indices = Uint32Array.from([...left.indices, ...right.indices.map(index => index + count)]);
  const geometry = { positions, normals, uvs, indices };
  const locked = findLockedVertices(indices, count * 2);
  const [level] = simplifyGeometry(geometry, { ratios: [0.2] });
  const seamUvs = new Map();
  for (let vertex = 0; vertex < level.geometry.positions.length / 3; vertex++) {
    if (level.geometry.positions[vertex * 3] !== 1) continue;
    const key = level.geometry.positions[vertex * 3 + 1];
    const uv = level.geometry.uvs[vertex * 2];
    seamUvs.set(key, [...(seamUvs.get(key) ?? []), uv]);
  }
  assert.equal(seamUvs.size, 13, 'every seam row survives');
  for (const uvsAtRow of seamUvs.values()) assert.deepEqual(uvsAtRow.sort(), [1, 7].sort());
  let lockedSeam = 0;
  for (let vertex = 0; vertex < count * 2; vertex++) if (locked[vertex] && positions[vertex * 3] === 1) lockedSeam++;
  assert.equal(lockedSeam, 26, 'the seam vertices of both sides are locked');
});

test('a geometry over the cap is refused with what to do', () => {
  const huge = { positions: new Float32Array(9), indices: new Uint32Array((MAXIMUM_SIMPLIFY_TRIANGLES + 1) * 3) };
  assert.throws(() => simplifyGeometry(huge), /at most 2000000 triangles.*got 2000001 triangles.*split the part/);
});

test('generateGeometryLods keeps the uvs of a textured geometry', () => {
  const geometry = sphere(32, 16);
  assert.ok(geometry.uvs, 'the test sphere has uvs');
  const levels = generateGeometryLods(geometry, { ratios: [0.25] });
  assert.equal(levels[0].geometry, geometry);
  assert.equal(levels[1].geometry.uvs.length, levels[1].geometry.positions.length / 3 * 2);
  assert.ok(levels[1].geometry.indices.length < geometry.indices.length);
  assert.ok(levels[1].error >= 0 && levels[1].relativeError >= 0);
});

test('simplifyGeometry says what to pass when the input is wrong', () => {
  assert.throws(() => simplifyGeometry({ positions: [] }, {}), /Float32Array positions/);
  assert.throws(() => simplifyGeometry(uvGrid(4), { ratios: [0.5, 0.6] }), /strictly decreasing/);
  assert.throws(() => simplifyGeometry({ ...uvGrid(4), joints: new Uint16Array(4) }), /skinned or morphed/);
});

function surfacePart(name, geometry, extra = {}) {
  return { name, geometry, matrix: new Float32Array(16), material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 }, ...extra };
}

test('a sparse scene gets no levels and the same array back', () => {
  const parts = [surfacePart('ball', sphere(32, 16))];
  assert.equal(addLodsToDenseParts(parts, { pixels: 1e9 }), parts);
});

test('a dense scene gives levels to big parts that can take them, sharing them between instances of one geometry', () => {
  const big = sphere(64, 32);
  const small = sphere(4, 4);
  const existing = [{ geometry: big, error: 0 }, { geometry: small, error: 1 }];
  const parts = [
    surfacePart('first', big),
    surfacePart('second', big),
    surfacePart('tiny', small),
    surfacePart('skinned', sphere(64, 32), { skin: {} }),
    surfacePart('kept', big, { lods: existing }),
  ];
  assert.ok(trianglesPerPixel(parts, 1000) > 1);
  const result = addLodsToDenseParts(parts, { pixels: 1000, minimumTriangles: 1000, ratios: [0.25] });
  assert.equal(result[0].lods.length, 2);
  assert.equal(result[0].lods, result[1].lods, 'instances of one geometry share levels');
  assert.equal(result[2].lods, undefined, 'a part under minimumTriangles is left alone');
  assert.equal(result[3].lods, undefined, 'a skinned part cannot take levels');
  assert.equal(result[4].lods, existing, 'levels that exist are kept');
});

test('addLodsToDenseParts says what to pass when the canvas size is missing', () => {
  assert.throws(() => addLodsToDenseParts([surfacePart('ball', sphere(8, 8))], {}), /canvas width times its height/);
});

test('addLodsToDenseParts rejects bad ratios on a sparse scene too', () => {
  const parts = [surfacePart('ball', sphere(8, 8))];
  assert.throws(() => addLodsToDenseParts(parts, { pixels: 1e9, ratios: [2] }), /ratios must be strictly decreasing/);
});

test('simplifyGeometry names an index past the vertex count instead of crashing in the collapser (#1900)', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const geometry = { positions, indices: new Uint32Array([0, 1, 2, 0, 2, 9]) };
  assert.throws(() => simplifyGeometry(geometry), error => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /index 9 at indices\[5\]/);
    assert.match(error.message, /4 vertices/);
    return true;
  });
  assert.throws(() => simplifyGeometry({ positions, indices: new Uint16Array([0, 1, 4]) }), /index 4 at indices\[2\]/);
});

test('simplifyGeometry names a positions length that is not a multiple of three (#1900)', () => {
  const geometry = { positions: new Float32Array(10), indices: new Uint32Array([0, 1, 2]) };
  assert.throws(() => simplifyGeometry(geometry), error => error instanceof RangeError && /length of 10/.test(error.message));
});

test('simplifyGeometry treats null options as the defaults (#1900)', () => {
  const geometry = sphere(16, 8);
  const withNull = simplifyGeometry(geometry, null);
  const withDefaults = simplifyGeometry(geometry);
  assert.deepEqual(withNull.map(level => level.triangles), withDefaults.map(level => level.triangles));
  assert.equal(withNull.length, 2);
});

test('simplifyGeometry still takes an index equal to the last vertex (#1900)', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const geometry = { positions, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
  assert.equal(simplifyGeometry(geometry, { ratios: [0.5] }).length, 1);
});

test('addLodsToDenseParts gives levels to mid-size meshes by default, so a scene of many of them is not left at full detail (#2144)', () => {
  const midSize = sphere(60, 40);
  const small = sphere(50, 30);
  const tiny = sphere(8, 8);
  assert.ok(midSize.indices.length / 3 >= DEFAULT_MINIMUM_TRIANGLES, 'the sphere is a mid-size mesh');
  assert.ok(midSize.indices.length / 3 < 20000, 'it is under the old 20000 floor');
  assert.ok(small.indices.length / 3 < DEFAULT_MINIMUM_TRIANGLES, 'a smaller mesh sits under the floor');
  const parts = [surfacePart('mid', midSize), surfacePart('small', small), surfacePart('tiny', tiny)];
  const result = addLodsToDenseParts(parts, { pixels: 100 });
  assert.ok(result[0].lods.length > 1, 'a mesh over the default floor gets levels');
  assert.equal(result[1].lods, undefined, 'a mesh under the default floor does not (4000 triangles, not 1500: the lower floor shimmered more and drew no faster, #2157)');
  assert.equal(result[2].lods, undefined, 'a tiny mesh does not');
});
