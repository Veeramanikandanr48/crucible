import { invalidField } from './field-error.js';
import { finiteNumber, knownKeys, vectorOfThree } from './agent-recipe-checks.js';
import {
  EXPLOSION_EMPTY_GRID, EXPLOSION_GRID_BOX, EXPLOSION_GRID_FPS, EXPLOSION_GRID_FRAMES, EXPLOSION_REFERENCE_SIZE,
  EXPLOSION_MOTION_BLUR_DEFAULT, GAS_SIM_TEMPERATURE_UNIT, explosionEmptyGridName, registerExplosionGrids,
} from './explosion-grids.js';
import { VOLUME_GRID_SEQUENCE_MAX_FRAMES } from './volume-grid-sequence.js';

// The add-explosion operation: one call writes a layered blast into ordinary recipe sections (effects, one gas-sim grid volume,
// particles, motion, physics), so scene_export_recipe shows plain parts an agent can tweak afterwards. The expansion is a
// pure function of the operation and the scene, so the same seed gives the same recipe byte for byte (#1050).

export const EXPLOSION_LIMITS = Object.freeze({
  size: [0.5, 100],
  start: [0, 3600],
  shake: [0, 1],
  maxIdLength: 64,
  fuels: Object.freeze(['dry', 'oily']),
  debrisSpeedLimit: 40,
});

const EXPLOSION_FIELDS = ['type', 'id', 'center', 'size', 'start', 'seed', 'fuel', 'debris', 'shake', 'ground', 'sparks', 'motionBlur', 'detail'];
const DEBRIS_FIELDS = ['node'];
const SPARK_FIELDS = ['count', 'speed', 'lifetime'];
// Bounds of the `sparks` overrides: the count stays well inside the 4096 sparks of one scene and the 4000 particles of a blast.
export const SPARK_OVERRIDE_LIMITS = Object.freeze({ count: [1, 2000], speed: [0, 100], lifetime: [0.05, 5] });
const DETAIL_FIELDS = ['strength', 'scale', 'octaves'];
/** The detail noise of the blast's grid volume when `detail` is a bare strength (#1832): lumps one grid cell wide, three octaves. */
const DETAIL_DEFAULTS = Object.freeze({ scale: 1, octaves: 3 });
const DETAIL_LIMITS = Object.freeze({ strength: [0, 1], scale: [0.25, 64], octaves: [1, 5] });
const SPARK_MODES = Object.freeze(['streaks', 'specks', 'none']);
/** Sparks are the spark streaks of #1761 unless the operation says "specks" (the plain glowing specks of the first release) or "none". */
export const EXPLOSION_SPARKS_DEFAULT = 'streaks';
/** The shutter in seconds of the fireball blur when the scene's camera has none: one frame at 24 frames per second, as in the approved preview. */
export const EXPLOSION_DEFAULT_SHUTTER = 0.0417;
const POSITION_LIMIT = 10000;
const SHAKE_SECONDS = 1;
const SHAKE_KEYS_PER_SECOND = 32;
const TICKS_PER_SECOND = 60;
const MAX_PHYSICS_SECONDS = 10;
const MAX_LOCAL_VOLUMES = 8;
const MAX_PARTICLE_SYSTEMS = 4;
const MAX_PARTICLES = 4000;
const MAX_AIR_SOURCES = 4;
const TINY = 0.001;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value) {
  return Number(value.toFixed(5));
}

function rangeOverride(value, path, [minimum, maximum]) {
  if (typeof value === 'number') return [finiteNumber(value, path, minimum, maximum), value];
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(path, value, `a number or [minimum, maximum] from ${minimum} to ${maximum}, such as [${Math.max(minimum, 1)}, ${Math.min(maximum, 3)}]`, TypeError);
  }
  const range = value.map((entry, index) => finiteNumber(entry, `${path}[${index}]`, minimum, maximum));
  if (range[0] > range[1]) throw invalidField(path, value, 'a range with the smaller number first');
  return range;
}

/** The `sparks` option as `{ streaks, count?, speed?, lifetime? }`: `streaks` false keeps the plain specks of the first release. */
function validatedSparks(value) {
  if (value === undefined) return { mode: EXPLOSION_SPARKS_DEFAULT };
  if (value === true) return { mode: 'streaks' };
  if (value === false) return { mode: 'specks' };
  if (typeof value === 'string') {
    if (!SPARK_MODES.includes(value)) throw invalidField('sparks', value, `one of ${SPARK_MODES.join(', ')} (true and false are aliases for streaks and specks), or { count, speed, lifetime } for streaks`);
    return { mode: value };
  }
  knownKeys(value, SPARK_FIELDS, 'sparks');
  const sparks = { mode: 'streaks' };
  if (value.count !== undefined) {
    const [minimum, maximum] = SPARK_OVERRIDE_LIMITS.count;
    if (!Number.isInteger(value.count) || value.count < minimum || value.count > maximum) {
      throw invalidField('sparks.count', value.count, `a whole number from ${minimum} to ${maximum}, such as 700`);
    }
    sparks.count = value.count;
  }
  if (value.speed !== undefined) sparks.speed = rangeOverride(value.speed, 'sparks.speed', SPARK_OVERRIDE_LIMITS.speed);
  if (value.lifetime !== undefined) sparks.lifetime = rangeOverride(value.lifetime, 'sparks.lifetime', SPARK_OVERRIDE_LIMITS.lifetime);
  return sparks;
}

function validatedMotionBlur(value) {
  if (value === undefined) return EXPLOSION_MOTION_BLUR_DEFAULT;
  if (typeof value !== 'boolean') throw invalidField('motionBlur', value, 'true to blur the fireball along its velocity or false to leave it sharp');
  return value;
}

/**
 * The `detail` option (#1832): a strength 0 to 1, or { strength, scale, octaves }, for the erosion that breaks up the edge of the blast while its grid is sampled.
 * Left out or 0 writes no detailNoise, so the blast is the one of the release before. Returns the volume's detailNoise or undefined.
 */
function validatedDetail(value) {
  if (value === undefined || value === null) return undefined;
  const expected = 'a strength from 0 to 1 such as 0.2, or { strength, scale, octaves } such as { strength: 0.35, scale: 1, octaves: 3 }';
  if (typeof value !== 'number' && (typeof value !== 'object' || Array.isArray(value))) throw invalidField('detail', value, expected, TypeError);
  const fields = typeof value === 'number' ? { strength: value } : value;
  knownKeys(fields, DETAIL_FIELDS, 'detail');
  const strength = finiteNumber(fields.strength, 'detail.strength', ...DETAIL_LIMITS.strength);
  const scale = fields.scale === undefined ? DETAIL_DEFAULTS.scale : finiteNumber(fields.scale, 'detail.scale', ...DETAIL_LIMITS.scale);
  const octaves = fields.octaves === undefined ? DETAIL_DEFAULTS.octaves : finiteNumber(fields.octaves, 'detail.octaves', ...DETAIL_LIMITS.octaves);
  if (!Number.isInteger(octaves)) throw invalidField('detail.octaves', octaves, 'a whole number from 1 to 5, such as 3');
  return strength === 0 ? undefined : { strength, scale, octaves };
}

/** Checks the operation and returns it with every default filled in. */
export function validatedExplosion(operation) {
  knownKeys(operation, EXPLOSION_FIELDS, 'operation');
  const { id } = operation;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || id.length > EXPLOSION_LIMITS.maxIdLength) {
    throw invalidField('id', id, `a string of 1 to ${EXPLOSION_LIMITS.maxIdLength} letters, digits, - or _, such as "blast"; every part of the blast gets an ID that starts with it`);
  }
  const center = vectorOfThree(operation.center, 'center', POSITION_LIMIT);
  const [minimumSize, maximumSize] = EXPLOSION_LIMITS.size;
  const size = finiteNumber(operation.size, 'size', minimumSize, maximumSize);
  const start = operation.start === undefined ? 0 : finiteNumber(operation.start, 'start', ...EXPLOSION_LIMITS.start);
  const seed = operation.seed === undefined ? 1 : finiteNumber(operation.seed, 'seed', 0, 4294967295);
  if (!Number.isInteger(seed)) throw invalidField('seed', seed, 'a whole number from 0 to 4294967295, such as 1');
  const fuel = operation.fuel ?? 'dry';
  if (!EXPLOSION_LIMITS.fuels.includes(fuel)) throw invalidField('fuel', fuel, `one of ${EXPLOSION_LIMITS.fuels.join(', ')}`);
  const ground = operation.ground === undefined ? center[1] : finiteNumber(operation.ground, 'ground', -POSITION_LIMIT, POSITION_LIMIT);
  let debris;
  if (operation.debris !== undefined) {
    knownKeys(operation.debris, DEBRIS_FIELDS, 'debris');
    if (typeof operation.debris.node !== 'string' || !operation.debris.node) {
      throw invalidField('debris.node', operation.debris.node, 'the ID of an existing mesh node to break apart, such as "crate"');
    }
    debris = { node: operation.debris.node };
  }
  const shake = operation.shake === undefined ? undefined : finiteNumber(operation.shake, 'shake', ...EXPLOSION_LIMITS.shake);
  return { id, center, size, start, seed, fuel, ground, debris, shake, sparks: validatedSparks(operation.sparks), motionBlur: validatedMotionBlur(operation.motionBlur), detail: validatedDetail(operation.detail) };
}

function claimIds(candidate, id) {
  const prefix = `${id}-`;
  const taken = [candidate.nodes, candidate.geometries, candidate.materials].flat().find(entry => entry.id.startsWith(prefix));
  if (taken) {
    throw invalidField('id', id, `an explosion ID no part uses yet; ${taken.id} already exists, so pick a new ID or remove the earlier blast's parts first`);
  }
}

function sourceVolume(geometry) {
  const { positions, indices } = geometry;
  let volume = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [0, 1, 2].map(offset => indices[corner + offset] * 3);
    volume += (positions[first] * (positions[second + 1] * positions[third + 2] - positions[second + 2] * positions[third + 1])
      - positions[first + 1] * (positions[second] * positions[third + 2] - positions[second + 2] * positions[third])
      + positions[first + 2] * (positions[second] * positions[third + 1] - positions[second + 1] * positions[third])) / 6;
  }
  return Math.abs(volume);
}

/** Keys of one track with times that repeat dropped, so a blast at time 0 needs no special case. */
function uniqueKeys(keys) {
  const result = [];
  for (const key of keys) {
    if (result.length === 0 || key.time > result.at(-1).time + 1e-6) result.push({ time: round(key.time), value: key.value });
    else result[result.length - 1] = { time: result.at(-1).time, value: key.value };
  }
  return result;
}

function addAirSteps(candidate, plan) {
  const { id, center, size, start } = plan;
  const effects = candidate.effects;
  const flashes = effects.flash === undefined ? [] : [effects.flash].flat();
  const rings = effects.distortion === undefined ? [] : [effects.distortion].flat();
  if (flashes.length >= MAX_AIR_SOURCES || rings.length >= MAX_AIR_SOURCES) {
    throw invalidField('id', id, `a scene with fewer than ${MAX_AIR_SOURCES} flash and distortion sources, since a blast adds one of each; clear effects.flash or effects.distortion first`);
  }
  flashes.push({
    centre: center, startTime: start, attack: 0, decay: round(0.12 + 0.04 * Math.sqrt(size)),
    intensity: 6, radius: round(size * 3), color: [1, 0.85, 0.6], ambient: 0.12,
  });
  rings.push({
    shape: 'ring', centre: center, startTime: start, speed: round(30 + 10 * Math.sqrt(size)),
    thickness: round(0.5 + 0.12 * size), strength: 0.9, falloff: 0.6, edge: 0.5, maxRadius: round(size * 8),
  });
  effects.flash = flashes.length === 1 ? flashes[0] : flashes;
  effects.distortion = rings;
}

// The fireball and the smoke are one gas-sim grid volume (#1735): a baked simulation of a ground blast, lit by the physical blackbody of its
// per-voxel temperature, with its shadow on the floor. The bake is fixed (one grid per fuel and seed, explosion-grids.js) and the volume's
// box scales it: the box is EXPLOSION_GRID_BOX metres at the reference size, the density and emission shrink with the box so the blast keeps
// its optical depth, and the playback speed follows the square root of the scale, the way a bigger fire rises slower.
// emissionStrength 9.5 (#1736): at 14 the core clipped to white and the edge fell off about 29% faster than the Cycles frame of the same grid on a flat
// background; at 9.5 (on top of the exact step integral, #1894) the edge falloff is 0.79 of the Cycles one and the RMSE drops from 0.030 to 0.020.
// steps 32 is one step per voxel of the 32 cubed grid: against 96 steps the picture differs by an RMSE of 0.003 (linear, 0 to 1), and a CPU preview
// look costs a third (SwiftShader, 768 x 432: first look 11.7 s to 4.9 s, later looks 4.2 s to 1.7 s), which keeps scene_look well under its 30 s limit.
// flameTemperature is Blender's fire remap (#1735): every voxel with flame emits at 1500 K up to 3000 K by its flame value, whatever its smoke density, which
// is the orange rim Cycles draws along the smoke edge (the temperature channel alone cools to nothing there).
const BLAST_VOLUME = Object.freeze({
  flameTemperature: Object.freeze({ ignition: 1.5, maximum: 3 }),
  density: 3, emission: [1, 0.45, 0.12], emissionStrength: 9.5, blackbodyIntensity: 0.3, absorption: [1, 1, 1], steps: 32,
});
const OILY_DENSITY_GAIN = 1.5;
const HOLD_SECONDS = 1;

function blastScale(size) {
  return size / EXPLOSION_REFERENCE_SIZE;
}

function blastFps(size) {
  return round(EXPLOSION_GRID_FPS / Math.sqrt(blastScale(size)));
}

/** The grid frames of the blast, with empty frames in front so it appears at `start`. */
function blastFrames(plan, names) {
  const padding = Math.ceil(plan.start * blastFps(plan.size));
  const room = VOLUME_GRID_SEQUENCE_MAX_FRAMES - names.length;
  if (padding > room) {
    const latest = Math.floor(room / blastFps(plan.size) * 10) / 10;
    throw invalidField('start', plan.start, `at most ${latest} s for a blast of size ${plan.size}: the fireball plays from a list of at most ${VOLUME_GRID_SEQUENCE_MAX_FRAMES} grid frames, and the wait before it takes ${blastFps(plan.size)} empty frames a second; pass a smaller start, or start a timeline later instead`);
  }
  return [...Array(padding).fill(explosionEmptyGridName(plan.motionBlur)), ...names];
}

function blastSeconds(plan) {
  return EXPLOSION_GRID_FRAMES / blastFps(plan.size);
}

function addBlastVolume(candidate, plan) {
  const environment = candidate.environment;
  const existing = environment.localVolumes ?? [];
  if (existing.some(volume => volume.shape === 'grid')) {
    throw invalidField('id', plan.id, 'a scene with no grid volume yet: a scene draws one grid volume, and the blast is one; remove the other one with set-environment first');
  }
  if (existing.length >= MAX_LOCAL_VOLUMES) {
    throw invalidField('id', plan.id, `a scene with a free local volume (${existing.length} of ${MAX_LOCAL_VOLUMES} in use); remove one with set-environment first`);
  }
  const { center, ground } = plan;
  const scale = blastScale(plan.size);
  const frames = blastFrames(plan, registerExplosionGrids(plan.fuel, plan.seed, plan.motionBlur));
  const box = EXPLOSION_GRID_BOX * scale;
  const floor = Math.max(ground, center[1]);
  const densityGain = plan.oily ? OILY_DENSITY_GAIN : 1;
  existing.push({
    shape: 'grid',
    frames,
    fps: blastFps(plan.size),
    loop: false,
    center: [center[0], round(floor + box / 2), center[2]],
    size: [round(box), round(box), round(box)],
    density: round(BLAST_VOLUME.density * densityGain / scale),
    absorption: [...BLAST_VOLUME.absorption],
    emission: [...BLAST_VOLUME.emission],
    emissionStrength: round(BLAST_VOLUME.emissionStrength / scale),
    temperatureScale: GAS_SIM_TEMPERATURE_UNIT,
    flameTemperature: { ...BLAST_VOLUME.flameTemperature },
    blackbodyIntensity: BLAST_VOLUME.blackbodyIntensity,
    steps: BLAST_VOLUME.steps,
    castShadow: true,
    lightsScene: true,
    ...(plan.detail ? { detailNoise: { ...plan.detail } } : {}),
  });
  environment.localVolumes = existing;
  // The volume's own light (lightsScene) follows the fire, so the old point light and its track are gone. The bloom stays as the scene has it: raising it to 0.5
  // made the fireball glow where Cycles has no glare, and without the raise the blast is closer to Cycles at 0.1 and 0.45 s and equal at 1.2 s (#1735).
  if (plan.motionBlur) openShutter(candidate);
}

// A grid that carries velocity blurs over the scene's motion blur shutter (#1759), so the blur takes the shutter the camera already has and opens one
// frame at 24 frames a second when it has none.
function openShutter(candidate) {
  const motionBlur = candidate.effects.motionBlur ?? {};
  const shutter = motionBlur.shutter > 0 ? motionBlur.shutter : EXPLOSION_DEFAULT_SHUTTER;
  candidate.effects.motionBlur = { ...motionBlur, shutter };
}

function addMaterial(candidate, id, fields) {
  candidate.materials.push({ id, ...fields });
}

// The spark streaks of the approved combined preview (#1761): 700 sparks (900 for oily fuel) thrown in every direction from a small ball above the
// floor, cooling along the blackbody curve. The fireball is 2.5 m at the reference size, so lengths scale with the blast and speeds with its square root,
// the way the grid's own playback does. The shutter stays the spark default (half a frame), as in the preview.
function sparkStreakSpecification(plan) {
  const { size, oily, sparks } = plan;
  const scale = blastScale(size);
  const speedScale = Math.sqrt(scale);
  const floor = Math.max(plan.ground, plan.center[1]);
  return {
    name: 'sparks', type: 'sparks', material: 'spark-glow', count: sparks.count ?? (oily ? 900 : 700),
    lifetime: sparks.lifetime ?? [0.5, 2], speed: sparks.speed ?? [round(2 * speedScale), round(9 * speedScale)],
    size: [round(0.008 * speedScale), round(0.016 * speedScale)], spread: 180, drag: 0.9,
    emitter: { shape: 'sphere', position: [plan.center[0], round(floor + 0.2 * size), plan.center[2]], radius: round(0.08 * size) },
  };
}

function particleSystems(candidate, plan, random) {
  const { id, center, size, start, ground, oily } = plan;
  const reach = Math.sqrt(size);
  const piece = `${id}-speck`;
  candidate.geometries.push({ id: piece, type: 'box', bevel: 0 });
  // A spark streak writes its blackbody radiance as the vertex colour, so its material is unlit white (src/particle-sparks.js).
  if (plan.sparks.mode === 'streaks') addMaterial(candidate, `${id}-spark-glow`, { tag: 'unlit', color: [1, 1, 1], emission: 0 });
  if (plan.sparks.mode === 'specks') addMaterial(candidate, `${id}-spark-glow`, { color: [1, 0.5, 0.1], emission: 8, emissiveColor: [1, 0.5, 0.1], roughness: 1 });
  addMaterial(candidate, `${id}-dust-grey`, { color: [0.45, 0.4, 0.34], roughness: 1 });
  addMaterial(candidate, `${id}-rubble-grey`, { color: [0.12, 0.11, 0.1], roughness: 0.9 });
  const specification = [
    plan.sparks.mode === 'streaks' ? sparkStreakSpecification(plan) : { name: 'sparks', material: 'spark-glow', count: oily ? 900 : 700, lifetime: [0.6, 2], speed: [round(size * 1.5 + 3), round(size * 4 + 8)], size: round(0.012 * reach), spread: 85, drag: 0.5, scale: 'shrink', emitter: { shape: 'sphere', position: [...center], radius: round(size * 0.15) }, color: [[1, 0.9, 0.5], [0.8, 0.2, 0.05]] },
    { name: 'dust', material: 'dust-grey', count: 360, lifetime: [1.5, 3.2], speed: [round(size * 0.8), round(size * 2.2)], size: [round(0.08 * reach), round(0.22 * reach)], spread: 88, drag: 1.8, scale: 'grow', emitter: { shape: 'disc', position: [center[0], ground, center[2]], radius: round(size * 0.3) }, alpha: [0.8, 0] },
    { name: 'rubble', material: 'rubble-grey', count: 60, lifetime: [1.5, 3], speed: [round(size * 0.8 + 2), round(size * 2.4 + 5)], size: [0.04, round(0.1 + 0.03 * size)], spread: 70, drag: 0.1, floor: ground, bounce: 0.3, scale: 'constant', emitter: { shape: 'sphere', position: [...center], radius: round(size * 0.1) } },
  ];
  if (plan.sparks.mode === 'none') specification.shift();
  return specification.map(({ name, material, ...settings }, index) => {
    candidate.nodes.push({ id: `${id}-${name}`, geometry: piece, material: `${id}-${material}`, castShadow: false });
    return { node: `${id}-${name}`, seed: Math.floor(random() * 1e9) + index, delay: start, direction: [0, 1, 0], floor: ground, ...settings };
  });
}

function addParticles(candidate, plan, random) {
  const section = candidate.particles ?? { systems: [] };
  const systems = particleSystems(candidate, plan, random).map(system => JSON.parse(JSON.stringify(system)));
  const total = [...section.systems, ...systems].reduce((sum, system) => sum + (system.count ?? 100), 0);
  if (section.systems.length + systems.length > MAX_PARTICLE_SYSTEMS || total > MAX_PARTICLES) {
    throw invalidField('id', plan.id, `a scene with room for ${systems.length} more particle systems and ${MAX_PARTICLES} particles in all (${section.systems.length} of ${MAX_PARTICLE_SYSTEMS} systems in use, ${total} particles would be needed); clear particles with set-particles first`);
  }
  section.systems.push(...systems);
  candidate.particles = section;
}

function addScorch(candidate, plan) {
  const { id, center, size, start, ground } = plan;
  const radius = round(size * 0.55);
  candidate.geometries.push({ id: `${id}-disc`, type: 'cylinder', bevel: 0 });
  addMaterial(candidate, `${id}-char`, { color: [0.1, 0.09, 0.08], roughness: 1 });
  candidate.nodes.push({ id: `${id}-scorch`, geometry: `${id}-disc`, material: `${id}-char`, translation: [center[0], round(ground + 0.004), center[2]], scale: [radius, 0.004, radius], decal: true, castShadow: false });
  // The MCP schema has no node visible track, so the disc is a speck until the blast and jumps to full size at `start`.
  const speck = [TINY, TINY, TINY];
  return [{ kind: 'node', id: `${id}-scorch`, property: 'scale', interpolation: 'STEP', keyframes: uniqueKeys([{ time: 0, value: speck }, { time: start, value: [radius, 0.004, radius] }]) }];
}

function shakeTrack(candidate, plan, random) {
  const { center, size, start } = plan;
  const eye = candidate.camera?.eye ?? [4, 3, 5];
  const distance = Math.max(1, Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]));
  const amplitude = plan.shake * 0.015 * distance * Math.min(2, Math.max(0.3, size / 10));
  const keys = [{ time: 0, value: [...eye] }, { time: start, value: [...eye] }];
  const count = SHAKE_SECONDS * SHAKE_KEYS_PER_SECOND;
  for (let index = 1; index <= count; index++) {
    const seconds = index / SHAKE_KEYS_PER_SECOND;
    const decay = index === count ? 0 : Math.exp(-4.5 * seconds) * amplitude;
    keys.push({ time: start + seconds, value: eye.map(component => round(component + (random() * 2 - 1) * decay)) });
  }
  return { kind: 'camera', property: 'eye', interpolation: 'LINEAR', keyframes: uniqueKeys(keys) };
}

function throwDebris(candidate, plan, helpers, random) {
  const { id, center, start, size } = plan;
  const node = candidate.nodes.find(entry => entry.id === plan.debris.node);
  if (!node) {
    throw invalidField('debris.node', plan.debris.node, `the ID of an existing node, one of ${candidate.nodes.slice(0, 8).map(entry => entry.id).join(', ') || 'none yet'}`);
  }
  const physics = candidate.physics;
  if (!physics?.bodies?.some(body => body.type === 'fixed')) {
    throw invalidField('debris.node', plan.debris.node, 'used after a set-physics that holds a fixed floor body; physics carries the pieces, so set it first');
  }
  const cells = 12;
  const jointsBefore = new Set((physics.joints ?? []).map(joint => joint.name));
  const volume = sourceVolume(helpers.sourceGeometry(node.geometry));
  const scale = node.scale ?? [1, 1, 1];
  const pieceMass = volume * scale[0] * scale[1] * scale[2] / cells;
  helpers.fractureNode({ type: 'fracture-node', node: node.id, cells, strength: 1, seed: plan.seed });
  const prefix = `${node.id}-frag-`;
  physics.joints = (physics.joints ?? []).filter(joint => jointsBefore.has(joint.name) || !joint.name.startsWith(`${node.id}-glue-`));
  if (physics.joints.length === 0) delete physics.joints;
  const origin = node.translation ?? [0, 0, 0];
  const away = [origin[0] - center[0], 0, origin[2] - center[2]];
  const awayLength = Math.hypot(...away) || 1;
  const speed = Math.min(EXPLOSION_LIMITS.debrisSpeedLimit, 4 + size * 0.8);
  const tick = Math.round(start * TICKS_PER_SECOND);
  const bodies = physics.bodies.filter(body => body.node.startsWith(prefix));
  const events = physics.events ?? [];
  for (const body of bodies) {
    const direction = [away[0] / awayLength + (random() - 0.5) * 1.2, 0.6 + random() * 0.6, away[2] / awayLength + (random() - 0.5) * 1.2];
    const length = Math.hypot(...direction);
    const impulse = direction.map(component => round(component / length * speed * pieceMass * body.density * (0.7 + random() * 0.6)));
    const torqueImpulse = [0, 1, 2].map(() => round((random() - 0.5) * pieceMass * body.density * speed * 0.2));
    events.push({ tick, body: body.node, impulse, torqueImpulse });
  }
  physics.events = events;
  physics.duration = Math.min(MAX_PHYSICS_SECONDS, Math.max(physics.duration ?? 3, start + 3));
  return id;
}

/**
 * The add-explosion operation. Appends the parts of one blast to `candidate`, each ID prefixed by the explosion ID.
 * `helpers.fractureNode(operation)` fractures a node in `candidate`, and `helpers.sourceGeometry(geometryId)` returns its mesh.
 */
export function addExplosion(candidate, rawOperation, helpers) {
  const plan = { ...validatedExplosion(rawOperation) };
  claimIds(candidate, plan.id);
  plan.oily = plan.fuel === 'oily';
  const random = seededRandom(plan.seed);
  addAirSteps(candidate, plan);
  addBlastVolume(candidate, plan);
  const tracks = [];
  addParticles(candidate, plan, random);
  tracks.push(...addScorch(candidate, plan));
  if (plan.debris) throwDebris(candidate, plan, helpers, random);
  const motion = candidate.motion ?? { duration: 1, tracks: [] };
  const cameraTracked = motion.tracks.some(track => track.kind === 'camera' && track.property === 'eye');
  if (plan.shake !== undefined && plan.shake > 0 && cameraTracked) {
    throw invalidField('shake', plan.shake, 'left out or 0, since the camera already has an eye track; shake is its own eye track, so remove that track or shake 0');
  }
  const shaking = (plan.shake ?? 0.4) > 0 && !cameraTracked;
  if (shaking) tracks.push(shakeTrack(candidate, { ...plan, shake: plan.shake ?? 0.4 }, random));
  motion.tracks.push(...tracks);
  motion.duration = Math.max(motion.duration, plan.start + blastSeconds(plan) + HOLD_SECONDS);
  candidate.motion = motion;
}
