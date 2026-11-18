import { invalidField } from './field-error.js';
import { meshDistanceField, planDistanceField } from './modeling-sdf.js';
import { CLOUD_LEVEL_LIMITS, growLevels, levelSettings, levelUnion, smoothMinimum } from './cloud-levels.js';
import { seededRandom } from './seeded-random.js';

// The cloud geometry: a seeded cluster of round puffs (a wide base of lobes with a tower of smaller ones above it), joined by a
// smooth union and meshed by surface nets as one closed surface. Plain arithmetic in a fixed order, so a seed gives the same bytes.

export const CLOUD_LIMITS = Object.freeze({
  puffs: [2, 48],
  width: [0.5, 2000],
  height: [0.25, 2000],
  flatBase: [0, 1],
  resolution: [16, 96],
  seed: [0, 0x7fffffff],
  defaults: Object.freeze({ seed: 1, puffs: 14, width: 10, height: 5, flatBase: 0.6, resolution: 48 }),
});
const CLOUD_FIELDS = ['id', 'type', 'seed', 'puffs', 'width', 'height', 'flatBase', 'resolution', 'levels', 'upBias', 'unionSoftness'];
// The dome the puffs are drawn in, in arbitrary units: half width at the base, height, how fast it narrows toward the top, how
// strongly puffs favour the lower half, and how deep below the dome surface a shell puff may sit (share of the reach). The core
// lobes cover CORE_HEIGHT_SHARE of the height with CORE_RADIUS_SHARE of the dome reach. OVERLAP_SHARE is how deep two neighbours
// sink into each other.
const DOME_HALF_WIDTH = 1.6;
const DOME_HEIGHT = 2.6;
const DOME_NARROWING = 0.55;
const DOME_HEIGHT_BIAS = 1.3;
const SHELL_DEPTH = 0.8;
const CORE_LOBES = 4;
const CORE_HEIGHT_SHARE = 0.9;
const CORE_RADIUS_SHARE = 0.8;
const OVERLAP_SHARE = 0.4;
const BLEND_PER_RADIUS = 0.14;
const BASE_ROUNDING_PER_RADIUS = 0.12;
const FULL_TURN = Math.PI * 2;
// Vertices reserved per resolution squared for a cloud with levels; towers measured 2 to 3.1 at resolution 128 to 160 (the check after meshing is the real limit).
const LEVEL_VERTICES_PER_SQUARED_RESOLUTION = 4;
// With levels the normal is the field gradient over this share of a cell, small enough to follow the small bumps.
const LEVEL_NORMAL_STEP_SHARE = 0.15;

function limited(value, name, whole, limits = CLOUD_LIMITS) {
  const [minimum, maximum] = limits[name];
  const fallback = limits.defaults[name];
  const resolved = value ?? fallback;
  const valid = Number.isFinite(resolved) && resolved >= minimum && resolved <= maximum && (!whole || Number.isInteger(resolved));
  if (!valid) {
    throw invalidField(`cloud.${name}`, resolved, `${whole ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}, such as ${fallback}`);
  }
  return resolved;
}

// The levels, upBias and unionSoftness fields live in CLOUD_LEVEL_LIMITS; resolution has its own range once levels are given.
function leveledSettings(value, levels) {
  const limits = CLOUD_LEVEL_LIMITS;
  return {
    levels: levelSettings(levels),
    upBias: limited(value.upBias, 'upBias', false, limits),
    unionSoftness: limited(value.unionSoftness, 'unionSoftness', false, limits),
    resolution: limited(value.resolution, 'resolution', true, limits),
  };
}

/** Validates a cloud record and returns its settings with the defaults filled in. */
export function cloudSettings(value) {
  for (const key of Object.keys(value)) {
    if (!CLOUD_FIELDS.includes(key)) throw invalidField(`cloud.${key}`, value[key], `one of ${CLOUD_FIELDS.slice(2).join(', ')}; remove "${key}"`);
  }
  if (value.levels !== undefined && value.puffs !== undefined) {
    throw invalidField('cloud.puffs', value.puffs, 'left out when levels is given; the first level count sets the big lobes, so remove puffs');
  }
  if (value.levels === undefined && value.upBias !== undefined) {
    throw invalidField('cloud.upBias', value.upBias, 'used together with levels; add levels such as [{count: 7, sizeRatio: 1}, {count: 60, sizeRatio: 0.35}] or remove upBias');
  }
  const shared = {
    seed: limited(value.seed, 'seed', true),
    width: limited(value.width, 'width', false),
    height: limited(value.height, 'height', false),
    flatBase: limited(value.flatBase, 'flatBase', false),
  };
  if (value.levels !== undefined) return { ...shared, puffs: null, ...leveledSettings(value, value.levels) };
  return {
    ...shared,
    puffs: limited(value.puffs, 'puffs', true),
    resolution: limited(value.resolution, 'resolution', true),
    levels: null,
    upBias: null,
    unionSoftness: value.unionSoftness === undefined ? null : limited(value.unionSoftness, 'unionSoftness', false, CLOUD_LEVEL_LIMITS),
  };
}

/** The vertex count to reserve for a cloud record: validated, not meshed. */
export function cloudVertexEstimate(value) {
  const { resolution, levels } = cloudSettings(value);
  return (levels ? LEVEL_VERTICES_PER_SQUARED_RESOLUTION : 8) * resolution * resolution;
}

// A dome of lobes. A few big core lobes stacked on the axis fill the inside, so the surface has no cavities; the other puffs sit
// on the shell of the dome, which narrows toward the top, smaller higher up. Each shell puff is pulled toward its nearest
// neighbour until the two overlap, so the cluster is one piece. Sizes are in an arbitrary unit and are fitted to the box after.
function scatterPuffs({ seed, puffs }) {
  const random = (index, channel) => seededRandom(index, channel, seed);
  const coreCount = Math.max(1, Math.min(CORE_LOBES, Math.floor(puffs / 4)));
  const lobes = [];
  for (let core = 0; core < coreCount; core++) {
    const climb = core / coreCount * CORE_HEIGHT_SHARE;
    lobes.push({ center: [0, climb * DOME_HEIGHT, 0], radius: CORE_RADIUS_SHARE * domeReach(climb) });
  }
  for (let index = lobes.length; index < puffs; index++) {
    const climb = random(index, 0) ** DOME_HEIGHT_BIAS;
    const reach = domeReach(climb) * (SHELL_DEPTH + (1 - SHELL_DEPTH) * Math.sqrt(random(index, 1)));
    const azimuth = random(index, 2) * FULL_TURN;
    const radius = (0.66 - 0.3 * climb) * (0.8 + 0.4 * random(index, 3));
    const center = [Math.cos(azimuth) * reach, climb * DOME_HEIGHT, Math.sin(azimuth) * reach];
    lobes.push({ center: pulledToNeighbour(center, radius, lobes), radius });
  }
  return lobes;
}

// The lobes of every level, each an array of { center, radius }: the dome layout alone, or the dome grown into levels.
function scatterLevels(settings) {
  if (!settings.levels) return [scatterPuffs(settings)];
  const baseLobes = scatterPuffs({ seed: settings.seed, puffs: settings.levels[0].count });
  return growLevels(baseLobes, settings.levels, settings);
}

function domeReach(climb) {
  return DOME_HALF_WIDTH * (1 - climb) ** DOME_NARROWING;
}

// Moves a new lobe along the line to its nearest earlier lobe until they overlap by a fifth of the smaller radius or more.
function pulledToNeighbour(center, radius, lobes) {
  let nearest = lobes[0];
  let nearestGap = Infinity;
  for (const lobe of lobes) {
    const gap = Math.hypot(center[0] - lobe.center[0], center[1] - lobe.center[1], center[2] - lobe.center[2]);
    if (gap < nearestGap) {
      nearest = lobe;
      nearestGap = gap;
    }
  }
  const wanted = nearest.radius + radius - OVERLAP_SHARE * Math.min(nearest.radius, radius);
  if (nearestGap <= wanted) return center;
  const pull = wanted / nearestGap;
  return center.map((value, axis) => nearest.center[axis] + (value - nearest.center[axis]) * pull);
}


function extentOf(lobes, axis) {
  const low = Math.min(...lobes.map(lobe => lobe.center[axis] - lobe.radius));
  const high = Math.max(...lobes.map(lobe => lobe.center[axis] + lobe.radius));
  return { low, high };
}

// Centres the layout on x and z and rests it on y = 0, then picks the stretch that takes it to the requested box. Stretching
// the whole layout keeps every overlap, so the puffs stay joined; tall or flat clouds get squashed or stretched lobes.
function fitLayout(levelLobes, { width, height }) {
  const lobes = levelLobes.flat();
  const x = extentOf(lobes, 0);
  const y = extentOf(lobes, 1);
  const z = extentOf(lobes, 2);
  const centred = ({ center, radius }) => ({
    center: [center[0] - (x.low + x.high) / 2, center[1] - y.low, center[2] - (z.low + z.high) / 2],
    radius,
  });
  const side = width / Math.max(x.high - x.low, z.high - z.low);
  return { levelLobes: levelLobes.map(level => level.map(centred)), stretch: [side, height / (y.high - y.low), side] };
}

// The union of the lobes with the underside cut flat by a plane that rounds off where it meets them, in layout units. flatBase 0
// keeps the round underside of the lowest lobes; 1 cuts as far as the widest lobe reaches. A union of one level blends by a share
// of the widest lobe; with levels, each level blends by a share of its own widest lobe, so small bumps stay crisp.
function layoutField(levelLobes, { flatBase, unionSoftness, levels }) {
  const lobes = levelLobes.flat();
  const widest = Math.max(...lobes.map(lobe => lobe.radius));
  const softness = unionSoftness ?? BLEND_PER_RADIUS;
  const blends = levelLobes.map(level => softness * (levels ? Math.max(...level.map(lobe => lobe.radius)) : widest));
  const union = levelUnion(levelLobes.map((level, index) => ({ lobes: level, blend: blends[index] })));
  const rounding = widest * BASE_ROUNDING_PER_RADIUS;
  const cutHeight = extentOf(lobes, 1).low + flatBase * widest * 0.9;
  const distance = (x, y, z) => {
    const joined = union(x, y, z);
    if (flatBase === 0) return joined;
    return -smoothMinimum(-joined, y - cutHeight, rounding);
  };
  return { distance, cutHeight, slack: Math.max(...blends) / 4 };
}

// The field in metres: points go back into layout units, and distances come out scaled by the smallest stretch so they never
// overstate how far a point is from the surface. y = 0 is the cut base.
function stretchedField({ levelLobes, stretch }, settings) {
  const lobes = levelLobes.flat();
  const { distance, cutHeight, slack } = layoutField(levelLobes, settings);
  const [stretchX, stretchY, stretchZ] = stretch;
  const shortest = Math.min(...stretch);
  const extents = [0, 1, 2].map(axis => extentOf(lobes, axis));
  const lowestLayoutY = Math.max(extents[1].low, cutHeight);
  return {
    distance: (x, y, z) => distance(x / stretchX, y / stretchY + cutHeight, z / stretchZ) * shortest,
    bounds: {
      min: [(extents[0].low - slack) * stretchX, (lowestLayoutY - cutHeight - slack) * stretchY, (extents[2].low - slack) * stretchZ],
      max: [(extents[0].high + slack) * stretchX, (extents[1].high - cutHeight + slack) * stretchY, (extents[2].high + slack) * stretchZ],
    },
  };
}

/** Mesh a cloud record: positions, gradient normals (not yet unit length), UVs and indices, one closed surface with its flat base at y = 0 and the width and height as asked, before the base is cut. */
export function cloudMesh(value) {
  const settings = cloudSettings(value);
  const field = stretchedField(fitLayout(scatterLevels(settings), settings), settings);
  const plan = planDistanceField(field, settings.resolution);
  if (!settings.levels) return meshDistanceField(plan);
  const mesh = meshDistanceField({ ...plan, normalStep: plan.edge * LEVEL_NORMAL_STEP_SHARE });
  checkFaceCount(mesh, settings.resolution);
  return mesh;
}

export function checkFaceCount({ indices }, resolution) {
  const faces = indices.length / 3;
  if (faces > CLOUD_LEVEL_LIMITS.faces) {
    const lowered = Math.max(CLOUD_LEVEL_LIMITS.resolution[0], Math.floor(resolution * Math.sqrt(CLOUD_LEVEL_LIMITS.faces / faces)));
    throw new RangeError(`cloud.resolution ${resolution} makes ${faces} faces, over the limit of ${CLOUD_LEVEL_LIMITS.faces}. Pass resolution ${lowered} or lower, or use fewer lobes.`);
  }
}
