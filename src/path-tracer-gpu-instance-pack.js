import { buildTriangleBvh } from './triangle-bvh.js';
import { createTable, writeTriangles } from './path-tracer-gpu-pack.js';
import { TRIANGLE_TEXELS } from './path-tracer-gpu-shader.js';
import { INSTANCE_TEXELS } from './path-tracer-gpu-instancing.js';

// Lays an instanced trace scene (`scene.instances`, see buildInstancedTraceScene) out as the tables the instanced GPU kernel reads:
// one triangle table and one bottom-level BVH per distinct mesh, a top-level BVH over the copies, and one record per copy.
// Plain typed arrays, so it runs and is tested without a GPU.

// The mesh as the flat packer reads it: a mesh without UVs or colours gets the (0, 0) UV and white vertex colour a flattened part gets.
function meshAsTriangleSource(geometry, bvh) {
  const vertexCount = geometry.positions.length / 3;
  return {
    positions: geometry.positions,
    normals: geometry.normals,
    uvs: geometry.uvs ?? new Float32Array(vertexCount * 2),
    uvs1: geometry.uvs1 ?? geometry.lightUvs ?? null,
    colors: geometry.colors ?? new Float32Array(vertexCount * 3).fill(1),
    indices: geometry.indices,
    triangleMaterial: new Uint32Array(geometry.indices.length / 3),
    bvh,
  };
}

/** Writes the nodes of `bvh` at node `nodeBase`, with child links and triangle slots moved by `nodeBase` and `slotBase`. */
function writeNodes(data, bvh, nodeBase, slotBase) {
  for (let node = 0; node < bvh.nodeCount; node++) {
    const target = (nodeBase + node) * 8;
    for (let axis = 0; axis < 3; axis++) {
      data[target + axis] = bvh.nodeBounds[node * 6 + axis];
      data[target + 4 + axis] = bvh.nodeBounds[node * 6 + 3 + axis];
    }
    const right = bvh.rightChild[node];
    data[target + 3] = right < 0 ? -bvh.rangeCount[node] : nodeBase + right;
    data[target + 7] = slotBase + bvh.rangeStart[node];
  }
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

/**
 * The inverse of the upper 3x3 of a column-major matrix, as nine numbers in row order: the rows of the inverse are the cross products
 * of the other two columns over the determinant. A matrix that squashes space gives zeros (its copy then misses every ray).
 */
function invertUpperMatrix(matrix) {
  const columns = [[matrix[0], matrix[1], matrix[2]], [matrix[4], matrix[5], matrix[6]], [matrix[8], matrix[9], matrix[10]]];
  const rows = [cross(columns[1], columns[2]), cross(columns[2], columns[0]), cross(columns[0], columns[1])];
  const determinant = columns[0][0] * rows[0][0] + columns[0][1] * rows[0][1] + columns[0][2] * rows[0][2];
  if (!(Math.abs(determinant) > 0)) return new Array(9).fill(0);
  return rows.flat().map(value => value / determinant);
}

function writeInstance(data, record, matrix, blasRoot, materialIndex) {
  const base = record * INSTANCE_TEXELS * 4;
  const inverse = invertUpperMatrix(matrix);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) data[base + row * 4 + column] = inverse[row * 3 + column];
    data[base + row * 4 + 3] = -(inverse[row * 3] * matrix[12] + inverse[row * 3 + 1] * matrix[13] + inverse[row * 3 + 2] * matrix[14]);
  }
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) data[base + (3 + column) * 4 + row] = matrix[column * 4 + row];
  }
  data[base + 24] = blasRoot;
  data[base + 25] = materialIndex;
}

// The world box of an instance: the corners of its mesh's root box, moved by the matrix.
function worldBox(rootBounds, matrix) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? rootBounds[3] : rootBounds[0];
    const y = corner & 2 ? rootBounds[4] : rootBounds[1];
    const z = corner & 4 ? rootBounds[5] : rootBounds[2];
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return { low, high };
}

/** The top-level BVH: the world box of each instance goes through the triangle builder as a one-triangle mesh, one instance to a leaf where it can. */
function buildTopLevelBvh(instances, bottomLevel) {
  const positions = new Float64Array(instances.length * 9);
  const indices = new Uint32Array(instances.length * 3);
  instances.forEach((instance, index) => {
    const { low, high } = worldBox(bottomLevel.get(instance.geometry).bvh.nodeBounds, instance.matrix);
    positions.set([...low, ...high, ...low], index * 9);
    indices.set([index * 3, index * 3 + 1, index * 3 + 2], index * 3);
  });
  return buildTriangleBvh(positions, indices, { leafSize: 1 });
}

/**
 * The tables of an instanced scene. `nodes` holds every bottom-level BVH followed by the top-level one, which starts at node
 * `topRoot`; a top-level leaf names instance slots, and `instances` holds the instance records in that leaf order. `triangles`
 * holds each distinct mesh once, in leaf order of its own BVH, with the same ten-texel record as a flattened scene.
 */
export function packInstancedScene(scene) {
  const { instances } = scene;
  const bottomLevel = new Map();
  let nodeTotal = 0;
  let triangleTotal = 0;
  for (const { geometry } of instances) {
    if (bottomLevel.has(geometry)) continue;
    const bvh = buildTriangleBvh(geometry.positions, geometry.indices);
    bottomLevel.set(geometry, { bvh, nodeBase: nodeTotal, slotBase: triangleTotal });
    nodeTotal += bvh.nodeCount;
    triangleTotal += geometry.indices.length / 3;
  }
  const top = buildTopLevelBvh(instances, bottomLevel);
  const nodes = createTable((nodeTotal + top.nodeCount) * 2);
  const triangles = createTable(triangleTotal * TRIANGLE_TEXELS);
  for (const [geometry, { bvh, nodeBase, slotBase }] of bottomLevel) {
    writeNodes(nodes.data, bvh, nodeBase, slotBase);
    writeTriangles(triangles.data, slotBase, meshAsTriangleSource(geometry, bvh), { secondUvSet: true });
  }
  writeNodes(nodes.data, top, nodeTotal, 0);
  const records = createTable(instances.length * INSTANCE_TEXELS);
  top.triangleOrder.forEach((instanceIndex, slot) => {
    const instance = instances[instanceIndex];
    writeInstance(records.data, slot, instance.matrix, bottomLevel.get(instance.geometry).nodeBase, instance.materialIndex);
  });
  return { nodes, triangles, instances: records, topRoot: nodeTotal, triangleCount: triangleTotal };
}
