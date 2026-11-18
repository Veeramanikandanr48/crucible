import { invalidField } from './field-error.js';
import { seededRandom } from './seeded-random.js';

// Cloud levels: lobes grown on the surface of the lobes before them (a few big ones, many medium ones on those, many small bumps on
// those), and the smooth union that joins them. Level 0 is checked against every lobe; deeper levels find their neighbours in a
// uniform grid, so hundreds of bumps do not make every sample cost one distance per bump. Plain arithmetic in a fixed order.

export const CLOUD_LEVEL_LIMITS = Object.freeze({
  levels: [1, 4],
  firstLevelCount: [1, 48],
  count: [1, 1000],
  sizeRatio: [0.02, 2],
  totalLobes: 1000,
  upBias: [0, 1],
  unionSoftness: [0.02, 1],
  resolution: [16, 160],
  faces: 150_000,
  defaults: Object.freeze({ upBias: 0.5, unionSoftness: 0.3, resolution: 128 }),
});
const LEVEL_FIELDS = ['count', 'sizeRatio'];
// A grown lobe sits this share of its radius inside its parent's surface, so it protrudes by the rest.
const SINK_SHARE = 0.3;
const SIZE_JITTER = 0.4;
// A deeper level only matters near the surface it grows on: past this many (radius + blend) from the union so far, its lobes
// are skipped. The surface being meshed is always closer than that.
const REACH_PER_RADIUS = 2;
const FULL_TURN = Math.PI * 2;
// Channels of the seeded random draws, kept apart from the base layout's channels 0 to 3.
const LEVEL_CHANNEL_START = 16;

function levelError(path, value, expected) {
  return invalidField(`cloud.levels${path}`, value, expected);
}

/** Validates the `levels` array and returns it as [{ count, sizeRatio }]. */
export function levelSettings(levels) {
  const [minimumLevels, maximumLevels] = CLOUD_LEVEL_LIMITS.levels;
  if (!Array.isArray(levels) || levels.length < minimumLevels || levels.length > maximumLevels) {
    throw levelError('', levels, `an array of ${minimumLevels} to ${maximumLevels} levels such as [{count: 7, sizeRatio: 1}, {count: 60, sizeRatio: 0.35}, {count: 680, sizeRatio: 0.12}]`);
  }
  const settings = levels.map((level, index) => levelSetting(level, index));
  const total = settings.reduce((sum, level) => sum + level.count, 0);
  if (total > CLOUD_LEVEL_LIMITS.totalLobes) {
    throw levelError('', total, `at most ${CLOUD_LEVEL_LIMITS.totalLobes} lobes in all; lower a count`);
  }
  return settings;
}

function levelSetting(level, index) {
  const path = `[${index}]`;
  if (level === null || typeof level !== 'object' || Array.isArray(level)) throw levelError(path, level, 'an object {count, sizeRatio}');
  for (const key of Object.keys(level)) {
    if (!LEVEL_FIELDS.includes(key)) throw levelError(`${path}.${key}`, level[key], `one of ${LEVEL_FIELDS.join(', ')}; remove "${key}"`);
  }
  const [minimumCount, maximumCount] = index === 0 ? CLOUD_LEVEL_LIMITS.firstLevelCount : CLOUD_LEVEL_LIMITS.count;
  if (!Number.isInteger(level.count) || level.count < minimumCount || level.count > maximumCount) {
    throw levelError(`${path}.count`, level.count, `a whole number from ${minimumCount} to ${maximumCount}`);
  }
  const [minimumRatio, maximumRatio] = CLOUD_LEVEL_LIMITS.sizeRatio;
  if (!Number.isFinite(level.sizeRatio) || level.sizeRatio < minimumRatio || level.sizeRatio > maximumRatio) {
    throw levelError(`${path}.sizeRatio`, level.sizeRatio, `a number from ${minimumRatio} to ${maximumRatio}, the lobe size as a share of the first level's, such as ${index === 0 ? 1 : 0.35}`);
  }
  return { count: level.count, sizeRatio: level.sizeRatio };
}

// A direction on the unit sphere. upBias 0 is uniform; 1 flattens the lower half onto the equator, so lobes grow up and out.
function growthDirection(index, channel, seed, upBias) {
  const height = random(index, channel, seed) * 2 - 1;
  const azimuth = random(index, channel + 1, seed) * FULL_TURN;
  const ring = Math.sqrt(1 - height * height);
  const lifted = height < 0 ? height * (1 - upBias) : height;
  const direction = [ring * Math.cos(azimuth), lifted, ring * Math.sin(azimuth)];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return direction.map(value => value / length);
}

function random(index, channel, seed) {
  return seededRandom(index, channel, seed);
}

// The parent whose share of the total surface area (radius squared) covers `position`, 0 to 1: big lobes carry more children, so
// small and large ones end up equally covered, and each lobe's children are an even run of the sequence.
function parentBySurface(parents, position) {
  const total = parents.reduce((sum, parent) => sum + parent.radius ** 2, 0);
  let covered = 0;
  for (const parent of parents) {
    covered += parent.radius ** 2;
    if (position * total <= covered) return parent;
  }
  return parents[parents.length - 1];
}

/** Level 0 is the base layout scaled by its sizeRatio; each later level puts its lobes on the lobes of the level before, each a share of its parent's radius (the ratio of the two sizeRatios). Returns an array of lobe arrays. */
export function growLevels(baseLobes, levels, { seed, upBias }) {
  const grown = [baseLobes.map(({ center, radius }) => ({ center, radius: radius * levels[0].sizeRatio }))];
  for (let level = 1; level < levels.length; level++) {
    const parents = grown[level - 1];
    const channel = LEVEL_CHANNEL_START * level;
    const shrink = levels[level].sizeRatio / levels[level - 1].sizeRatio;
    const lobes = [];
    for (let index = 0; index < levels[level].count; index++) {
      const parent = parentBySurface(parents, (index + 0.5) / levels[level].count);
      const radius = parent.radius * shrink * (1 - SIZE_JITTER / 2 + SIZE_JITTER * random(index, channel + 2, seed));
      const direction = growthDirection(index, channel, seed, upBias);
      const reach = parent.radius - SINK_SHARE * radius;
      lobes.push({ center: parent.center.map((value, axis) => value + direction[axis] * reach), radius });
    }
    grown.push(lobes);
  }
  return grown;
}

export function smoothMinimum(first, second, blend) {
  const weight = Math.max(blend - Math.abs(first - second), 0) / blend;
  return Math.min(first, second) - weight * weight * blend / 4;
}

function widestRadius(lobes) {
  return lobes.reduce((widest, lobe) => Math.max(widest, lobe.radius), 0);
}

// A uniform grid of lobe centres: cells are counted, then lobe numbers are written in order, so each cell lists its lobes by number.
function gridOf(lobes, cellSize) {
  const low = [0, 1, 2].map(axis => Math.min(...lobes.map(lobe => lobe.center[axis])));
  const high = [0, 1, 2].map(axis => Math.max(...lobes.map(lobe => lobe.center[axis])));
  const cells = low.map((start, axis) => Math.floor((high[axis] - start) / cellSize) + 1);
  const cellOf = lobe => lobe.center.map((value, axis) => Math.floor((value - low[axis]) / cellSize));
  const flat = ([x, y, z]) => (z * cells[1] + y) * cells[0] + x;
  const starts = new Int32Array(cells[0] * cells[1] * cells[2] + 1);
  for (const lobe of lobes) starts[flat(cellOf(lobe)) + 1]++;
  for (let cell = 0; cell < starts.length - 1; cell++) starts[cell + 1] += starts[cell];
  const filled = starts.slice();
  const members = new Int32Array(lobes.length);
  lobes.forEach((lobe, number) => {
    members[filled[flat(cellOf(lobe))]++] = number;
  });
  return { low, cells, starts, members, cellSize };
}

function packLobes(lobes) {
  const packed = new Float64Array(lobes.length * 4);
  lobes.forEach(({ center, radius }, number) => packed.set([center[0], center[1], center[2], radius], number * 4));
  return packed;
}

// Folds the lobes of one deeper level into `best`, in lobe order. A lobe changes the result only where its distance is within
// `blend` of the union so far, which is inside a ball of radius (radius + blend + best) around its centre, so only the lobes
// whose cells meet the box of that ball are folded; the rest would return `best` unchanged.
function levelFolder(lobes, blend) {
  const widest = widestRadius(lobes);
  const reach = REACH_PER_RADIUS * (widest + blend);
  const grid = gridOf(lobes, widest + blend + reach);
  const packed = packLobes(lobes);
  const candidates = new Int32Array(lobes.length);
  const range = (position, radius, axis) => [
    Math.max(0, Math.floor((position - radius - grid.low[axis]) / grid.cellSize)),
    Math.min(grid.cells[axis] - 1, Math.floor((position + radius - grid.low[axis]) / grid.cellSize)),
  ];
  return (best, x, y, z) => {
    if (best > reach) return best;
    const radius = widest + blend + best;
    const [fromX, toX] = range(x, radius, 0);
    const [fromY, toY] = range(y, radius, 1);
    const [fromZ, toZ] = range(z, radius, 2);
    let count = 0;
    for (let cellZ = fromZ; cellZ <= toZ; cellZ++) {
      for (let cellY = fromY; cellY <= toY; cellY++) {
        const row = (cellZ * grid.cells[1] + cellY) * grid.cells[0];
        for (let position = grid.starts[row + fromX]; position < grid.starts[row + toX + 1]; position++) candidates[count++] = grid.members[position];
      }
    }
    const ordered = candidates.subarray(0, count).sort();
    let union = best;
    for (const number of ordered) {
      const offset = number * 4;
      const distance = Math.sqrt((x - packed[offset]) ** 2 + (y - packed[offset + 1]) ** 2 + (z - packed[offset + 2]) ** 2) - packed[offset + 3];
      union = smoothMinimum(union, distance, blend);
    }
    return union;
  };
}

/** The smooth union of levels [{ lobes, blend }] as a distance function; level 0 checks every lobe, deeper levels use a grid. */
export function levelUnion(levels) {
  const [first, ...deeper] = levels;
  const folders = deeper.map(({ lobes, blend }) => levelFolder(lobes, blend));
  return (x, y, z) => {
    let union = Infinity;
    for (const { center, radius } of first.lobes) {
      const lobeDistance = Math.hypot(x - center[0], y - center[1], z - center[2]) - radius;
      union = Number.isFinite(union) ? smoothMinimum(union, lobeDistance, first.blend) : lobeDistance;
    }
    for (const fold of folders) union = fold(union, x, y, z);
    return union;
  };
}

/** Every lobe of every level checked one by one, with no grid and no skipping: the reference the grid is tested against. */
export function levelUnionByBruteForce(levels) {
  return (x, y, z) => {
    let union = Infinity;
    for (const { lobes, blend } of levels) {
      for (const { center, radius } of lobes) {
        const lobeDistance = Math.hypot(x - center[0], y - center[1], z - center[2]) - radius;
        union = Number.isFinite(union) ? smoothMinimum(union, lobeDistance, blend) : lobeDistance;
      }
    }
    return union;
  };
}
