// Edge collapse for renderer geometry that keeps every vertex attribute (normals, uvs, light uvs, colours, sky
// visibility) exactly as it was: a collapse moves the removed vertex onto a vertex that stays, so no attribute is
// ever blended or invented. Vertices on a border of the index buffer (an open edge, a UV seam, a hard edge) never
// move or disappear, so textures and shading breaks stay where they were. The cost of a collapse is the quadric error
// of Garland and Heckbert (the same measure `mesh-decimate.js` uses on mesh data, which drops uvs).
// Used for scans and textured models that `generateGeometryLods` could not reduce before (#1163).
// Every plane counts once (not by face area), so the square root of a quadric cost is a distance in the units of the
// positions and scales with the mesh: tiny triangles do not make a collapse look cheaper.

const PER_VERTEX_ATTRIBUTES = [['normals', 3], ['uvs', 2], ['lightUvs', 2], ['colors', 3], ['skyVisibility', 1]];
const MINIMUM_NORMAL_AGREEMENT = 0.2;
const MINIMUM_TRIANGLES = 4;
/** The most triangles and vertices one geometry may have: the edge map and the heap grow with them. */
export const MAXIMUM_SIMPLIFY_TRIANGLES = 2000000;
export const MAXIMUM_SIMPLIFY_VERTICES = 2000000;

class MinHeap {
  constructor() {
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  push(entry) {
    const entries = this.entries;
    let index = entries.length;
    entries.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (entries[parent].cost <= entry.cost) break;
      entries[index] = entries[parent];
      index = parent;
    }
    entries[index] = entry;
  }

  pop() {
    const entries = this.entries;
    const top = entries[0];
    const last = entries.pop();
    if (entries.length) {
      let index = 0;
      for (;;) {
        let child = index * 2 + 1;
        if (child >= entries.length) break;
        if (child + 1 < entries.length && entries[child + 1].cost < entries[child].cost) child++;
        if (entries[child].cost >= last.cost) break;
        entries[index] = entries[child];
        index = child;
      }
      entries[index] = last;
    }
    return top;
  }
}

function validateGeometry(geometry) {
  if (!(geometry?.positions instanceof Float32Array) || !(geometry.indices instanceof Uint32Array || geometry.indices instanceof Uint16Array)) {
    throw new TypeError('simplifyGeometry needs a geometry with Float32Array positions and Uint16Array or Uint32Array indices.');
  }
  if (geometry.indices.length % 3 !== 0) throw new RangeError('simplifyGeometry needs indices that hold whole triangles.');
  if (geometry.positions.length % 3 !== 0) {
    throw new RangeError(`simplifyGeometry needs positions with three numbers per vertex, got a length of ${geometry.positions.length}: pass x, y, z for every vertex.`);
  }
  const triangleCount = geometry.indices.length / 3;
  const vertexCount = geometry.positions.length / 3;
  if (triangleCount > MAXIMUM_SIMPLIFY_TRIANGLES || vertexCount > MAXIMUM_SIMPLIFY_VERTICES) {
    throw new RangeError(`simplifyGeometry takes at most ${MAXIMUM_SIMPLIFY_TRIANGLES} triangles and ${MAXIMUM_SIMPLIFY_VERTICES} vertices per geometry, got ${triangleCount} triangles and ${vertexCount} vertices: split the part into smaller geometries or skip levels for it.`);
  }
  for (const field of ['joints', 'weights', 'morphTargets']) {
    if (geometry[field]) throw new RangeError(`simplifyGeometry cannot reduce skinned or morphed geometry (${field}); its per-vertex weights would break.`);
  }
  validateIndexValues(geometry.indices, vertexCount);
}

function validateIndexValues(indices, vertexCount) {
  for (let position = 0; position < indices.length; position++) {
    if (indices[position] >= vertexCount) {
      throw new RangeError(`simplifyGeometry found index ${indices[position]} at indices[${position}] but the geometry has ${vertexCount} vertices: every index must be below the vertex count.`);
    }
  }
}

function validateRatios(ratios) {
  if (!Array.isArray(ratios) || ratios.length < 1) throw new RangeError('ratios needs at least one number between 0 and 1, strictly decreasing, for example [0.25, 0.06].');
  ratios.forEach((ratio, index) => {
    if (typeof ratio !== 'number' || !(ratio > 0) || !(ratio < 1) || (index > 0 && ratio >= ratios[index - 1])) {
      throw new RangeError('ratios must be strictly decreasing numbers above 0 and below 1, for example [0.25, 0.06].');
    }
  });
}

/** Vertices that touch an edge used by other than two triangles: they stay exactly as they are. */
export function findLockedVertices(indices, vertexCount) {
  const edgeCounts = new Map();
  const edgeKey = (first, second) => (first < second ? first * vertexCount + second : second * vertexCount + first);
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const key = edgeKey(indices[corner + side], indices[corner + (side + 1) % 3]);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  const locked = new Uint8Array(vertexCount);
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const first = indices[corner + side];
      const second = indices[corner + (side + 1) % 3];
      if (edgeCounts.get(edgeKey(first, second)) !== 2) {
        locked[first] = 1;
        locked[second] = 1;
      }
    }
  }
  return locked;
}

// A quadric is the symmetric 4x4 matrix of a plane sum, stored as ten numbers: aa ab ac ad bb bc bd cc cd dd.
function addPlane(quadrics, vertex, nx, ny, nz, planeOffset) {
  const base = vertex * 10;
  quadrics[base] += nx * nx;
  quadrics[base + 1] += nx * ny;
  quadrics[base + 2] += nx * nz;
  quadrics[base + 3] += nx * planeOffset;
  quadrics[base + 4] += ny * ny;
  quadrics[base + 5] += ny * nz;
  quadrics[base + 6] += ny * planeOffset;
  quadrics[base + 7] += nz * nz;
  quadrics[base + 8] += nz * planeOffset;
  quadrics[base + 9] += planeOffset * planeOffset;
}

function quadricError(quadrics, first, second, x, y, z) {
  const a = first * 10;
  const b = second * 10;
  const summedQuadricTerm = index => quadrics[a + index] + quadrics[b + index];
  const value = summedQuadricTerm(0) * x * x + 2 * summedQuadricTerm(1) * x * y + 2 * summedQuadricTerm(2) * x * z + 2 * summedQuadricTerm(3) * x
    + summedQuadricTerm(4) * y * y + 2 * summedQuadricTerm(5) * y * z + 2 * summedQuadricTerm(6) * y
    + summedQuadricTerm(7) * z * z + 2 * summedQuadricTerm(8) * z + summedQuadricTerm(9);
  return Math.max(0, value);
}

function buildQuadrics(positions, indices, vertexCount) {
  const quadrics = new Float64Array(vertexCount * 10);
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [indices[corner], indices[corner + 1], indices[corner + 2]];
    const ax = positions[second * 3] - positions[first * 3];
    const ay = positions[second * 3 + 1] - positions[first * 3 + 1];
    const az = positions[second * 3 + 2] - positions[first * 3 + 2];
    const bx = positions[third * 3] - positions[first * 3];
    const by = positions[third * 3 + 1] - positions[first * 3 + 1];
    const bz = positions[third * 3 + 2] - positions[first * 3 + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const doubleArea = Math.hypot(nx, ny, nz);
    if (doubleArea === 0) continue;
    nx /= doubleArea;
    ny /= doubleArea;
    nz /= doubleArea;
    const planeDistance = -(nx * positions[first * 3] + ny * positions[first * 3 + 1] + nz * positions[first * 3 + 2]);
    for (const vertex of [first, second, third]) addPlane(quadrics, vertex, nx, ny, nz, planeDistance);
  }
  return quadrics;
}

function triangleNormal(positions, first, second, third, replaced, replacement) {
  const point = vertex => (vertex === replaced ? replacement : vertex);
  const [pa, pb, pc] = [point(first) * 3, point(second) * 3, point(third) * 3];
  const ax = positions[pb] - positions[pa];
  const ay = positions[pb + 1] - positions[pa + 1];
  const az = positions[pb + 2] - positions[pa + 2];
  const bx = positions[pc] - positions[pa];
  const by = positions[pc + 1] - positions[pa + 1];
  const bz = positions[pc + 2] - positions[pa + 2];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

class Collapser {
  constructor(geometry) {
    this.geometry = geometry;
    this.positions = geometry.positions;
    this.vertexCount = geometry.positions.length / 3;
    this.triangles = Uint32Array.from(geometry.indices);
    this.triangleAlive = new Uint8Array(this.triangles.length / 3).fill(1);
    this.aliveCount = this.triangles.length / 3;
    this.locked = findLockedVertices(this.triangles, this.vertexCount);
    this.quadrics = buildQuadrics(this.positions, this.triangles, this.vertexCount);
    this.versions = new Uint32Array(this.vertexCount);
    this.vertexTriangles = Array.from({ length: this.vertexCount }, () => []);
    for (let triangle = 0; triangle < this.triangleAlive.length; triangle++) {
      for (let side = 0; side < 3; side++) this.vertexTriangles[this.triangles[triangle * 3 + side]].push(triangle);
    }
    this.heap = new MinHeap();
    this.worstError = 0;
    for (let triangle = 0; triangle < this.triangleAlive.length; triangle++) {
      for (let side = 0; side < 3; side++) this.pushEdge(this.triangles[triangle * 3 + side], this.triangles[triangle * 3 + (side + 1) % 3]);
    }
  }

  /** Queue both directions of an edge: the vertex that goes must not be locked. */
  pushEdge(first, second) {
    if (!this.locked[first]) this.pushCollapse(first, second);
    if (!this.locked[second]) this.pushCollapse(second, first);
  }

  pushCollapse(removed, kept) {
    const positions = this.positions;
    const cost = quadricError(this.quadrics, removed, kept, positions[kept * 3], positions[kept * 3 + 1], positions[kept * 3 + 2]);
    this.heap.push({ cost, removed, kept, removedVersion: this.versions[removed], keptVersion: this.versions[kept] });
  }

  /** The collapse keeps the surface a manifold and turns no neighbouring face over. */
  isSafe(removed, kept) {
    const around = this.vertexTriangles[removed];
    const neighbours = new Set();
    let shared = 0;
    for (const triangle of around) {
      const corners = [this.triangles[triangle * 3], this.triangles[triangle * 3 + 1], this.triangles[triangle * 3 + 2]];
      const containsKept = corners.includes(kept);
      if (containsKept) shared++;
      for (const corner of corners) if (corner !== removed && corner !== kept) neighbours.add(corner);
      if (containsKept) continue;
      const before = triangleNormal(this.positions, corners[0], corners[1], corners[2], -1, -1);
      const after = triangleNormal(this.positions, corners[0], corners[1], corners[2], removed, kept);
      const beforeLength = Math.hypot(...before);
      const afterLength = Math.hypot(...after);
      if (afterLength === 0 || beforeLength === 0) return false;
      const agreement = (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (beforeLength * afterLength);
      if (agreement < MINIMUM_NORMAL_AGREEMENT) return false;
    }
    if (shared !== 2) return false;
    // The link condition: the two vertices may share only the two apexes of the faces they share.
    let commonNeighbours = 0;
    for (const triangle of this.vertexTriangles[kept]) {
      for (let side = 0; side < 3; side++) {
        const corner = this.triangles[triangle * 3 + side];
        if (neighbours.delete(corner)) commonNeighbours++;
      }
    }
    return commonNeighbours === 2;
  }

  collapse(removed, kept) {
    for (const triangle of this.vertexTriangles[removed]) {
      const base = triangle * 3;
      const corners = [this.triangles[base], this.triangles[base + 1], this.triangles[base + 2]];
      if (corners.includes(kept)) {
        this.triangleAlive[triangle] = 0;
        this.aliveCount--;
        for (const corner of corners) {
          if (corner === removed) continue;
          const list = this.vertexTriangles[corner];
          list.splice(list.indexOf(triangle), 1);
        }
      } else {
        for (let side = 0; side < 3; side++) if (this.triangles[base + side] === removed) this.triangles[base + side] = kept;
        this.vertexTriangles[kept].push(triangle);
      }
    }
    this.vertexTriangles[removed] = [];
    for (let index = 0; index < 10; index++) this.quadrics[kept * 10 + index] += this.quadrics[removed * 10 + index];
    this.versions[removed]++;
    this.versions[kept]++;
    for (const triangle of this.vertexTriangles[kept]) {
      for (let side = 0; side < 3; side++) {
        const corner = this.triangles[triangle * 3 + side];
        if (corner !== kept) this.pushEdge(kept, corner);
      }
    }
  }

  /** Collapse the cheapest edges until `targetTriangles` are left or no safe collapse remains. */
  reduceTo(targetTriangles) {
    while (this.aliveCount > targetTriangles && this.heap.size) {
      const entry = this.heap.pop();
      if (entry.removedVersion !== this.versions[entry.removed] || entry.keptVersion !== this.versions[entry.kept]) continue;
      if (!this.isSafe(entry.removed, entry.kept)) continue;
      this.worstError = Math.max(this.worstError, entry.cost);
      this.collapse(entry.removed, entry.kept);
    }
  }

  /** The surviving triangles as new geometry with the vertices that they use, in their old order. */
  snapshot() {
    const remap = new Int32Array(this.vertexCount).fill(-1);
    const used = [];
    const indices = [];
    for (let triangle = 0; triangle < this.triangleAlive.length; triangle++) {
      if (!this.triangleAlive[triangle]) continue;
      for (let side = 0; side < 3; side++) {
        const vertex = this.triangles[triangle * 3 + side];
        if (remap[vertex] < 0) {
          remap[vertex] = used.length;
          used.push(vertex);
        }
        indices.push(remap[vertex]);
      }
    }
    const level = { ...this.geometry, positions: new Float32Array(used.length * 3), indices: Uint32Array.from(indices) };
    used.forEach((vertex, slot) => level.positions.set(this.positions.subarray(vertex * 3, vertex * 3 + 3), slot * 3));
    for (const [field, size] of PER_VERTEX_ATTRIBUTES) {
      const source = this.geometry[field];
      if (!source) continue;
      if (source.length !== this.vertexCount * size) throw new RangeError(`Geometry ${field} must hold ${size} numbers for every vertex.`);
      level[field] = new source.constructor(used.length * size);
      used.forEach((vertex, slot) => level[field].set(source.subarray(vertex * size, (vertex + 1) * size), slot * size));
    }
    return level;
  }
}

/**
 * Reduce a geometry to each ratio of its triangles. Returns one entry per ratio, `{ ratio, triangles, error, geometry }`,
 * where `error` is the square root of the largest quadric cost of any collapse so far: the distance, in the
 * geometry's units, that those collapses moved the surface (an estimate that grows from level to level). A level
 * may keep more triangles than asked when the border vertices and the shape leave no safe collapse.
 */
export function simplifyGeometry(geometry, options) {
  const { ratios = [0.25, 0.0625] } = options ?? {};
  validateGeometry(geometry);
  validateRatios(ratios);
  const collapser = new Collapser(geometry);
  const inputTriangles = geometry.indices.length / 3;
  return ratios.map(ratio => {
    collapser.reduceTo(Math.max(MINIMUM_TRIANGLES, Math.ceil(inputTriangles * ratio)));
    return { ratio, triangles: collapser.aliveCount, error: Math.sqrt(collapser.worstError), geometry: collapser.snapshot() };
  });
}
