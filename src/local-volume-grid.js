import { finiteRange, vectorField } from './volumetric.js';
import { VOLUME_GRID_SEQUENCE_MAX_FRAMES } from './volume-grid-sequence.js';
import { resolveGridDetailNoise } from './local-volume-grid-detail.js';

// Resolves a local volume of shape "grid" (#1045). It loads on demand (the volumeGrid module), so a scene without grid volumes does not carry it.
export const LOCAL_VOLUME_GRID_MAXIMUM_STEPS = 128;

const RESOLVED_DEFAULTS = Object.freeze({ falloff: 0, noiseAmount: 0, noiseScale: 1, noiseOctaves: 1 });

function resolveFrameNames(frames, label) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > VOLUME_GRID_SEQUENCE_MAX_FRAMES) {
    throw new RangeError(`${label}.frames must be a list of 1 to ${VOLUME_GRID_SEQUENCE_MAX_FRAMES} grid names`);
  }
  frames.forEach((name, index) => {
    if (typeof name !== 'string' || name === '') throw new TypeError(`${label}.frames[${index}] must be the name of a grid file, such as "blast_0001.67vg"`);
  });
}

// Blender's flame remap (#1735): `flameTemperature: { ignition, maximum }` (temperature units, so 1.5 and 3 are 1500 K and 3000 K at temperatureScale 1000)
// makes the volume emit from the flame channel as `flame > 0.01 ? ignition + flame * (maximum - ignition) : 0` instead of from the temperature channel.
function resolveFlameTemperature(input, label) {
  if (input === undefined) return {};
  const fieldLabel = `${label}.flameTemperature`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${fieldLabel} must be { ignition, maximum }, such as { ignition: 1.5, maximum: 3 } (Blender's fire defaults); leave it out to emit from the temperature channel`);
  for (const key of Object.keys(input)) {
    if (key !== 'ignition' && key !== 'maximum') throw new TypeError(`${fieldLabel}.${key} is not a field; it takes ignition and maximum`);
  }
  const ignition = finiteRange(input.ignition, 0, 1e3, `${fieldLabel}.ignition`);
  const maximum = finiteRange(input.maximum, 0, 1e3, `${fieldLabel}.maximum`);
  if (maximum < ignition) throw new RangeError(`${fieldLabel}.maximum (${maximum}) must be at least ignition (${ignition}): the flame grows from the ignition temperature up to the maximum`);
  return { flameTemperature: { ignition, maximum } };
}

// A grid volume is a box (center, size) whose density, temperature and flame come from a registered grid (volume-grid.js). Its size defaults to the
// grid file's own size once the grid is bound. The faded edge and the noise belong to the other shapes: a grid has its own detail.
export function resolveGridVolume(input, resolved, label) {
  const animated = input.frames !== undefined;
  if (animated) {
    if (input.grid !== undefined) throw new TypeError(`${label} takes either grid (one still grid) or frames (a sequence), not both`);
    resolveFrameNames(input.frames, label);
  } else {
    for (const field of ['fps', 'loop']) {
      if (input[field] !== undefined) throw new TypeError(`${label}.${field} belongs to a grid volume with frames`);
    }
    if (typeof input.grid !== 'string' || input.grid === '') throw new TypeError(`${label}.grid must be the name of a registered grid (registerVolumeGrid), made from a VDB by scripts/vdb-to-grid.py; or pass frames, a list of grid names, for an animation`);
  }
  if (input.loop !== undefined && typeof input.loop !== 'boolean') throw new TypeError(`${label}.loop must be true or false`);
  for (const field of ['part', 'fit', 'radius']) {
    if (input[field] !== undefined) throw new TypeError(`${label}.${field} does not apply to a grid volume; it takes center, size and grid`);
  }
  // A resolved volume carries these three at their defaults, and a scene resolves its look again (a rebuild, an export read back), so the defaults pass.
  for (const [field, value] of Object.entries(RESOLVED_DEFAULTS)) {
    if (input[field] !== undefined && input[field] !== value) throw new TypeError(`${label}.${field} does not apply to a grid volume: its detail comes from the grid`);
  }
  const steps = finiteRange(input.steps ?? 64, 4, LOCAL_VOLUME_GRID_MAXIMUM_STEPS, `${label}.steps`);
  if (!Number.isInteger(steps)) throw new RangeError(`${label}.steps must be an integer`);
  return {
    ...resolved,
    falloff: 0,
    steps,
    ...(animated ? { frames: input.frames.slice(), fps: finiteRange(input.fps ?? 24, 0.01, 240, `${label}.fps`), loop: input.loop ?? true } : { grid: input.grid }),
    ...(input.size === undefined ? {} : { size: vectorField(input.size, 0.001, 1e4, `${label}.size`) }),
    temperatureScale: finiteRange(input.temperatureScale ?? 1, 0, 1e5, `${label}.temperatureScale`),
    ...resolveFlameTemperature(input.flameTemperature, label),
    blackbodyIntensity: finiteRange(input.blackbodyIntensity ?? 0, 0, 1, `${label}.blackbodyIntensity`),
    anisotropy: finiteRange(input.anisotropy ?? 0, -0.9, 0.9, `${label}.anisotropy`),
    // Kept off a volume without it, so a grid volume without the field resolves to the same object as before (#1832).
    ...(input.detailNoise === undefined ? {} : { detailNoise: resolveGridDetailNoise(input.detailNoise, `${label}.detailNoise`) }),
  };
}
