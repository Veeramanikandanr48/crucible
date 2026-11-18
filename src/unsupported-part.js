// Warns when a whole part hangs off the surface it rests on, such as a building with half its footprint past the edge of a
// rock. mesh_inspect's floating-part check only looks inside one mesh; this one looks across the parts of the scene.
//
// Each candidate part gets a grid of probe points over its footprint (its bounds seen from above). A probe is supported when
// a surface of another part lies within SUPPORT_TOLERANCE of the part's lowest point, or inside the part's own height (a
// building sunk into terrain). A part is reported only when it is partly supported, under SUPPORT_SHARE, and the support
// reaches past the part on some side: a roof over its walls or a table top on one pedestal has supports that sit inside its
// footprint, and a part with nothing under it at all is taken to hover on purpose. Both stay quiet.
// The check is deterministic, bounded (see the limits below) and reads no clock.
import { diagnostic } from './agent-diagnostics.js';
import { buildTriangleBvh } from './triangle-bvh.js';
import { createTracer } from './ray-query.js';

/** How far a surface may be from the part's lowest point, in metres, and still hold it up. */
export const SUPPORT_TOLERANCE = 0.02;
/** A part with a smaller supported share of its footprint is reported. */
export const SUPPORT_SHARE = 0.7;
/** Probes per side of the footprint grid: 16 probes, each the centre of a cell, so an edge never sits on a probe. */
export const PROBES_PER_SIDE = 4;
/** The largest footprint first, so a scene past this many parts still gets its biggest parts checked. */
export const MAXIMUM_CHECKED_PARTS = 64;
/** Parts narrower than this on either horizontal side are props, not buildings or objects that need a base. */
export const MINIMUM_FOOTPRINT = 0.1;
/** A scene with more triangles than this is not checked: the check builds one hierarchy over all of them. */
export const MAXIMUM_TRIANGLES = 400_000;
// Rays that pass through a part's own family (itself, its parents and children) before reaching another part.
const MAXIMUM_SELF_HITS = 6;
// The support must reach past the part by this share of the part's size to count as a base the part is perched on.
const OVERHANG_SHARE = 0.05;
const REPORTED_PARTS = 8;

function nodeIdsThatMove(recipe) {
  const ids = new Set();
  for (const track of recipe.motion?.tracks ?? []) {
    if (track.kind === 'node') ids.add(track.id);
  }
  for (const system of recipe.particles?.systems ?? []) {
    ids.add(system.node);
    ids.add(system.emitter?.mesh);
  }
  for (const entry of [...(recipe.cloth?.sheets ?? []), ...(recipe.cloth?.colliders ?? [])]) {
    ids.add(entry.node);
  }
  for (const body of recipe.physics?.bodies ?? []) {
    ids.add(body.node);
  }
  ids.delete(undefined);
  return ids;
}

/** Maps each node to the ids of its parents, nearest first. */
function ancestorLookup(nodes) {
  const parentOf = new Map(nodes.map(node => [node.id, node.parent ?? null]));
  const lookup = new Map();
  for (const node of nodes) {
    const chain = [];
    let current = parentOf.get(node.id);
    while (current && !chain.includes(current)) {
      chain.push(current);
      current = parentOf.get(current);
    }
    lookup.set(node.id, chain);
  }
  return lookup;
}

/** Part names that stand for something meant to float or move: animated, simulated, an emitter, a cloud, or a child of one. */
function partsMeantToFloat(recipe, ancestors) {
  const moving = nodeIdsThatMove(recipe);
  const cloudGeometries = new Set(recipe.geometries.filter(geometry => geometry.type === 'cloud').map(geometry => geometry.id));
  const floating = new Set();
  for (const node of recipe.nodes) {
    const isCloud = cloudGeometries.has(node.geometry);
    if (isCloud || moving.has(node.id) || ancestors.get(node.id).some(parent => moving.has(parent))) {
      floating.add(node.id);
    }
  }
  return floating;
}

function isTranslucent(part) {
  return ['blend', 'add'].includes(part.material?.alphaMode);
}

/** All parts as one triangle soup in world space, with the part each triangle belongs to and each part's bounds. */
function buildSupportWorld(parts) {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const part of parts) {
    vertexTotal += part.geometry.positions.length / 3;
    indexTotal += part.geometry.indices.length;
  }
  if (indexTotal === 0 || indexTotal / 3 > MAXIMUM_TRIANGLES) {
    return null;
  }
  const positions = new Float64Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const triangleOwner = new Uint32Array(indexTotal / 3);
  const bounds = [];
  let vertexOffset = 0;
  let triangleOffset = 0;
  parts.forEach((part, partIndex) => {
    const { matrix } = part;
    const source = part.geometry.positions;
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let vertex = 0; vertex < source.length / 3; vertex++) {
      const x = source[vertex * 3];
      const y = source[vertex * 3 + 1];
      const z = source[vertex * 3 + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        positions[(vertexOffset + vertex) * 3 + axis] = value;
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
    for (let slot = 0; slot < part.geometry.indices.length; slot++) {
      indices[triangleOffset * 3 + slot] = part.geometry.indices[slot] + vertexOffset;
    }
    triangleOwner.fill(partIndex, triangleOffset, triangleOffset + part.geometry.indices.length / 3);
    bounds.push({ minimum, maximum });
    vertexOffset += source.length / 3;
    triangleOffset += part.geometry.indices.length / 3;
  });
  return { triangleOwner, bounds, tracer: createTracer({ positions, indices, bvh: buildTriangleBvh(positions, indices) }) };
}

/**
 * The first surface straight up from a probe point that belongs to another family of parts, as a part index, or -1.
 * `family` holds the part indices that may not count: the part itself, its parents and its children.
 */
function supportAbove(world, family, x, y, z, reach) {
  let originY = y;
  for (let attempt = 0; attempt < MAXIMUM_SELF_HITS; attempt++) {
    const hit = world.tracer.trace(x, originY, z, 0, 1, 0, reach - (originY - y), false);
    if (hit.nearestTriangle < 0) {
      return -1;
    }
    const owner = world.triangleOwner[hit.nearestTriangle];
    if (!family.has(owner)) {
      return owner;
    }
    originY += hit.nearestDistance + 1e-6;
  }
  return -1;
}

function overhangs(supportBounds, partBounds) {
  return [0, 2].some(axis => {
    const margin = OVERHANG_SHARE * (partBounds.maximum[axis] - partBounds.minimum[axis]);
    return supportBounds.minimum[axis] < partBounds.minimum[axis] - margin || supportBounds.maximum[axis] > partBounds.maximum[axis] + margin;
  });
}

function footprintArea(bounds) {
  return (bounds.maximum[0] - bounds.minimum[0]) * (bounds.maximum[2] - bounds.minimum[2]);
}

function familyOf(part, parts, ancestors) {
  const parents = new Set(ancestors.get(part.name) ?? []);
  const family = new Set();
  parts.forEach((other, index) => {
    const otherParents = ancestors.get(other.name) ?? [];
    if (other === part || parents.has(other.name) || otherParents.includes(part.name)) {
      family.add(index);
    }
  });
  return family;
}

/**
 * Parts whose footprint is partly held up by another part and partly in the air, as
 * `{ part, supportedShare, supporters }` in the order of the scene's parts.
 */
export function findUnsupportedParts(parts, recipe) {
  const ancestors = ancestorLookup(recipe.nodes);
  const floating = partsMeantToFloat(recipe, ancestors);
  const solid = parts.filter(part => part.geometry?.indices.length > 0 && !isTranslucent(part));
  const world = buildSupportWorld(solid);
  if (!world) {
    return [];
  }
  const lowest = Math.min(...world.bounds.map(bounds => bounds.minimum[1]));
  const candidates = solid
    .map((part, index) => ({ part, index, bounds: world.bounds[index] }))
    .filter(({ part, bounds }) => !floating.has(part.name)
      && bounds.minimum[1] > lowest + SUPPORT_TOLERANCE
      && bounds.maximum[0] - bounds.minimum[0] >= MINIMUM_FOOTPRINT
      && bounds.maximum[2] - bounds.minimum[2] >= MINIMUM_FOOTPRINT)
    .sort((first, second) => footprintArea(second.bounds) - footprintArea(first.bounds))
    .slice(0, MAXIMUM_CHECKED_PARTS);
  const findings = [];
  for (const { part, index, bounds } of candidates) {
    const family = familyOf(part, solid, ancestors);
    const reach = bounds.maximum[1] - bounds.minimum[1] + 2 * SUPPORT_TOLERANCE;
    const supporters = new Set();
    let supported = 0;
    for (let row = 0; row < PROBES_PER_SIDE; row++) {
      for (let column = 0; column < PROBES_PER_SIDE; column++) {
        const x = bounds.minimum[0] + (column + 0.5) / PROBES_PER_SIDE * (bounds.maximum[0] - bounds.minimum[0]);
        const z = bounds.minimum[2] + (row + 0.5) / PROBES_PER_SIDE * (bounds.maximum[2] - bounds.minimum[2]);
        const owner = supportAbove(world, family, x, bounds.minimum[1] - SUPPORT_TOLERANCE, z, reach);
        if (owner >= 0) {
          supported++;
          supporters.add(owner);
        }
      }
    }
    const supportedShare = supported / (PROBES_PER_SIDE * PROBES_PER_SIDE);
    if (supported > 0 && supportedShare < SUPPORT_SHARE && [...supporters].some(owner => overhangs(world.bounds[owner], bounds))) {
      findings.push({ part, index, supportedShare, supporters: [...supporters].map(owner => solid[owner].name) });
    }
  }
  return findings.sort((first, second) => first.index - second.index);
}

function percent(share) {
  return Math.round(share * 100);
}

/** Warnings in the shape of `agent-diagnostics.js`, the least supported first, plus one line for the rest. */
export function unsupportedPartDiagnostics(findings) {
  const ranked = [...findings].sort((first, second) => first.supportedShare - second.supportedShare);
  const problems = ranked.slice(0, REPORTED_PARTS).map(({ part, supportedShare, supporters }) => ({
    ...diagnostic(
      'unsupported-part', 'warning', part.name,
      `${part.name} has ${percent(1 - supportedShare)} percent of its footprint with nothing under it (within ${SUPPORT_TOLERANCE * 100} cm of its base); ${percent(supportedShare)} percent rests on ${supporters.join(', ')}. From a low side view it hangs off the edge.`,
      `Move ${part.name} toward the middle of ${supporters[0]} until at least ${percent(SUPPORT_SHARE)} percent of its footprint sits on it, or make ${supporters[0]} wider. Leave it as is when it is meant to overhang (a balcony or an eave).`),
    unsupportedShare: Math.round((1 - supportedShare) * 100) / 100,
    nodes: [part.name, ...supporters],
  }));
  if (ranked.length > REPORTED_PARTS) {
    problems.push(diagnostic('unsupported-part', 'warning', 'scene', `${ranked.length - REPORTED_PARTS} more parts hang off their support.`, 'Fix the listed parts first, then inspect the scene again.'));
  }
  return problems;
}

let cache = null;

/** The warnings for a scene, computed once per revision of the scene and kept until it changes. */
export function unsupportedPartProblems(parts, recipe, revision) {
  if (cache?.parts !== parts || cache.revision !== revision) {
    cache = { parts, revision, problems: unsupportedPartDiagnostics(findUnsupportedParts(parts, recipe)) };
  }
  return cache.problems;
}
