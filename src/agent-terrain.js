// Recipe terrain: a seeded rolling ground with optional round holes, built with the terrain addon as one mesh.
// It loads on demand with the recipes that contain a terrain geometry, so the scene entry does not carry it.
import './world-material-shader.js';
import { createTerrain } from './terrain.js';
import { invalidField } from './field-error.js';
import { diagnostic } from './agent-diagnostics.js';
import { TERRAIN_DEFAULT_SIZE, TERRAIN_DEFAULT_RESOLUTION, holesCoverWholeGround, holesRemovingNoCell } from './terrain-hole-cells.js';

export const TERRAIN_LIMITS = Object.freeze({
  size: [1, 2000],
  resolution: [2, 256],
  amplitude: [0, 200],
  defaultSize: TERRAIN_DEFAULT_SIZE,
  defaultResolution: TERRAIN_DEFAULT_RESOLUTION,
  defaultAmplitude: 1,
  maximumHoles: 16,
  seed: [0, 0x7fffffff],
  defaultSeed: 1,
});

function numberWithin(value, fallback, [minimum, maximum], label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidField(`terrain.${label}`, resolved, `a number from ${minimum} to ${maximum}, such as ${fallback}`);
  }
  return resolved;
}

function integerWithin(value, fallback, [minimum, maximum], label) {
  const resolved = numberWithin(value, fallback, [minimum, maximum], label);
  if (!Number.isInteger(resolved)) throw invalidField(`terrain.${label}`, resolved, `a whole number, such as ${fallback}`);
  return resolved;
}

function terrainSeed(value) {
  const [minimum, maximum] = TERRAIN_LIMITS.seed;
  const resolved = value ?? TERRAIN_LIMITS.defaultSeed;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidField('terrain.seed', resolved, `a whole number from ${minimum} to ${maximum}, such as ${TERRAIN_LIMITS.defaultSeed}`);
  }
  return resolved;
}

/** Vertex count of a terrain record, checked against the recipe limits before any ground is built. */
export function terrainVertexEstimate(value) {
  const resolution = integerWithin(value.resolution, TERRAIN_LIMITS.defaultResolution, TERRAIN_LIMITS.resolution, 'resolution');
  const size = numberWithin(value.size, TERRAIN_LIMITS.defaultSize, TERRAIN_LIMITS.size, 'size');
  numberWithin(value.amplitude, TERRAIN_LIMITS.defaultAmplitude, TERRAIN_LIMITS.amplitude, 'amplitude');
  terrainSeed(value.seed);
  if (value.holes !== undefined && (!Array.isArray(value.holes) || value.holes.length > TERRAIN_LIMITS.maximumHoles)) {
    throw invalidField('terrain.holes', value.holes, `a list of at most ${TERRAIN_LIMITS.maximumHoles} circles, such as [{ "center": [0, 0], "radius": 2 }]`);
  }
  value.holes?.forEach(checkHole);
  checkHolesLeaveGround(value.holes, size, resolution);
  return (resolution + 1) * (resolution + 1);
}

/** Refuses holes that remove every cell: the terrain would have no surface and could not be exported. */
function checkHolesLeaveGround(holes, size, resolution) {
  if (!holesCoverWholeGround(holes, size, resolution)) return;
  throw invalidField('holes', holes, 'holes that leave some ground; these cover the whole terrain, so no surface would remain. Lower a radius or move a center');
}

function checkHole(hole, index) {
  const center = hole?.center;
  const validCenter = Array.isArray(center) && center.length === 2 && center.every(Number.isFinite);
  if (!validCenter) {
    throw invalidField(`terrain.holes[${index}].center`, center, 'a position [x, z] in metres, such as [0, 0]');
  }
  if (!Number.isFinite(hole.radius) || hole.radius <= 0) {
    throw invalidField(`terrain.holes[${index}].radius`, hole.radius, 'a positive number of metres, such as 2');
  }
}

/** The terrain addon object of a terrain record: render parts plus heightAt, isHole and bounds. Vegetation scatters over the same ground. */
export function createRecipeTerrain(value) {
  const size = value.size ?? TERRAIN_LIMITS.defaultSize;
  const seed = terrainSeed(value.seed);
  return createTerrain({
    size,
    chunks: 1,
    levels: 1,
    resolution: value.resolution ?? TERRAIN_LIMITS.defaultResolution,
    seed,
    holes: value.holes,
    height: {
      amplitude: value.amplitude ?? TERRAIN_LIMITS.defaultAmplitude,
      featureSize: size / 4,
      warp: 0,
      mountainMask: () => 0,
    },
  });
}

/** Render geometry of a terrain record: ground from -size / 2 to size / 2 on X and Z, hills of the given amplitude, holes cut out. */
export function generateTerrainGeometry(value, maxVertices) {
  const vertices = terrainVertexEstimate(value);
  if (vertices > maxVertices) throw invalidField('terrain.resolution', value.resolution ?? TERRAIN_LIMITS.defaultResolution, `a resolution whose ${vertices} vertices fit maxVertices ${maxVertices}; lower it`);
  return createRecipeTerrain(value).parts[0].geometry;
}

/** Warnings for holes of a terrain record that remove no ground cell, so the terrain looks as if it had no hole. */
export function terrainHoleDiagnostics(geometry) {
  return holesRemovingNoCell(geometry).map(({ index, cellSize, smallestRadius }) => diagnostic('terrain-hole-removes-no-cell', 'warning',
    `${geometry.id}.holes[${index}]`,
    `Hole ${index} of terrain ${geometry.id} removes no ground cell, so it changes nothing: cells are ${cellSize} m wide and a hole removes a cell only when it reaches the cell's centre.`,
    `Raise radius above ${smallestRadius} (the smallest that removes a cell here), move center onto a cell centre, or raise the terrain resolution.`));
}
