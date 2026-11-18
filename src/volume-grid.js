// Volume grids (#1045): a 3D texture of density, temperature and flame over the box of a local volume with `shape: "grid"`.
// A grid file holds half floats, x fastest, then y, then z, y up. `scripts/vdb-to-grid.py` writes one from an OpenVDB file.
//
//   bytes 0..3   "67VG"
//   bytes 4..7   uint32 version (1)
//   bytes 8..11  uint32 header length in bytes (a multiple of 4)
//   then         JSON header { resolution: [x, y, z], channels: ["density", ...], size: [x, y, z] (optional, scene units) }
//   then         for each channel in header order, x * y * z uint16 half floats

import { blackbodyChromaticity } from './local-volume-ramp-bake.js';

export const VOLUME_GRID_VERSION = 1;
export const VOLUME_GRID_MAX_AXIS = 256;
export const VOLUME_GRID_MAX_BYTES = 64 * 1024 * 1024;
// The three velocity channels (#1759) hold the gas velocity in the units of the header `size` per second (metres per second from the gas sim), x, y, z.
// A grid has all three or none; they drive the motion blur of a volume and change nothing else.
export const VOLUME_GRID_VELOCITY_CHANNELS = Object.freeze(['velocityX', 'velocityY', 'velocityZ']);
export const VOLUME_GRID_CHANNELS = Object.freeze(['density', 'temperature', 'flame', ...VOLUME_GRID_VELOCITY_CHANNELS]);
const MAGIC = [0x36, 0x37, 0x56, 0x47];

// Blackbody emission (#1733). The light of a hot body at `kelvin` is its Stefan-Boltzmann radiance, sigma * T^4 / pi, times a colour of luminance 1 whose
// hue is the Planckian locus. Blender's Principled Volume uses the same convention (intern/cycles/kernel/svm/closure.h, the blackbody branch of the volume
// emission, and svm_math_blackbody_color_rec709 in svm/math_util.h), so a grid fire matches Cycles in brightness as well as colour. Written from the physics:
// the code and the tables here are our own. sigma is 5.670373e-8 W/m^2/K^4; the 1e-6 turns W/m^2 into the scene's radiance unit, as Cycles does.
export const BLACKBODY_RADIANCE_SCALE = 5.670373e-8 * 1e-6 / Math.PI;
// The hue is baked once, every 200 K from 800 K (Cycles holds its colour constant below that) to 12000 K, and blended linearly. The rasterizer's
// shader carries the same table (fog-shader.js), so the two agree to float precision.
export const BLACKBODY_TABLE_FIRST_KELVIN = 800;
export const BLACKBODY_TABLE_STEP_KELVIN = 200;
export const BLACKBODY_TABLE_COUNT = 57;
const BLACKBODY_LUMINANCE = [0.2126, 0.7152, 0.0722];

function bakeBlackbodyTable() {
  const table = new Float64Array(BLACKBODY_TABLE_COUNT * 3);
  const hue = new Float64Array(3);
  for (let entry = 0; entry < BLACKBODY_TABLE_COUNT; entry++) {
    blackbodyChromaticity(BLACKBODY_TABLE_FIRST_KELVIN + entry * BLACKBODY_TABLE_STEP_KELVIN, hue);
    const luminance = hue[0] * BLACKBODY_LUMINANCE[0] + hue[1] * BLACKBODY_LUMINANCE[1] + hue[2] * BLACKBODY_LUMINANCE[2];
    for (let channel = 0; channel < 3; channel++) table[entry * 3 + channel] = hue[channel] / luminance;
  }
  return table;
}

/** The linear RGB colour of luminance 1 of a blackbody at each table temperature, `BLACKBODY_TABLE_COUNT * 3` values. */
export const BLACKBODY_HUE_TABLE = bakeBlackbodyTable();
/** Empty voxels the rasterizer's texture adds on every face of a grid, so the field ramps to 0 across the outer half voxel as an OpenVDB grid does (#1752). */
export const GRID_BORDER_VOXELS = 1;
/** The largest finite half float. The rasterizer's emission texture clamps to it, which only matters above about 35,000 K (sigma * T^4 / pi passes it there). */
export const HALF_FLOAT_MAXIMUM = 65504;

const floatBuffer = new Float32Array(1);
const floatBits = new Uint32Array(floatBuffer.buffer);

/** Converts half float bits to a number. */
export function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** Converts a number to half float bits, rounding to nearest even; values past 65504 become infinity. */
export function floatToHalf(value) {
  floatBuffer[0] = value;
  const bits = floatBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const fraction = bits & 0x7fffff;
  if (((bits >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (fraction ? 0x200 : 0);
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    // Round after the whole shift: the bits shifted out decide ties, so a value just above a midpoint rounds up.
    const shift = 14 - exponent;
    const mantissa = fraction | 0x800000;
    const kept = mantissa >> shift;
    const remainder = mantissa - (kept << shift);
    const halfway = 1 << (shift - 1);
    return sign | (kept + (remainder > halfway || (remainder === halfway && kept & 1) ? 1 : 0));
  }
  const rounded = (fraction + 0xfff + ((fraction >> 13) & 1)) >> 13;
  return sign + (exponent << 10) + rounded;
}

function gridLabel(label) {
  return label ? `${label}: ` : '';
}

/** Throws unless the resolution is three integers within 1 to VOLUME_GRID_MAX_AXIS and the channels fit VOLUME_GRID_MAX_BYTES. */
export function checkVolumeGridShape(resolution, channelCount, label) {
  if (!Array.isArray(resolution) || resolution.length !== 3) throw new TypeError(`${gridLabel(label)}grid resolution must be [x, y, z]`);
  for (const axis of resolution) {
    if (!Number.isInteger(axis) || axis < 1 || axis > VOLUME_GRID_MAX_AXIS) {
      throw new RangeError(`${gridLabel(label)}grid resolution ${resolution.join('x')} is out of range: each axis is an integer from 1 to ${VOLUME_GRID_MAX_AXIS}; convert with scripts/vdb-to-grid.py --max-resolution ${VOLUME_GRID_MAX_AXIS}`);
    }
  }
  const bytes = resolution[0] * resolution[1] * resolution[2] * 2 * channelCount;
  if (bytes > VOLUME_GRID_MAX_BYTES) {
    throw new RangeError(`${gridLabel(label)}grid ${resolution.join('x')} with ${channelCount} channels is ${bytes} bytes, over the ${VOLUME_GRID_MAX_BYTES} byte limit; lower --max-resolution or drop a channel`);
  }
  return bytes;
}

function checkVelocityChannels(names, label) {
  const present = VOLUME_GRID_VELOCITY_CHANNELS.filter(name => names.includes(name));
  if (present.length !== 0 && present.length !== VOLUME_GRID_VELOCITY_CHANNELS.length) {
    throw new TypeError(`${label}: a grid holds all of ${VOLUME_GRID_VELOCITY_CHANNELS.join(', ')} or none of them, got ${present.join(', ')}; add the missing velocity channels or drop these`);
  }
}

function checkGridSize(size, label) {
  if (size !== undefined && (!Array.isArray(size) || size.length !== 3 || !size.every(extent => Number.isFinite(extent) && extent > 0))) {
    throw new TypeError(`${label} header size must be three positive numbers`);
  }
}

/** Packs channels (Float32Array of numbers, or Uint16Array of half float bits) into a grid file. `size` is optional, in scene units. */
export function encodeVolumeGrid({ resolution, channels, size }) {
  const names = Object.keys(channels);
  checkVolumeGridShape(resolution, names.length, 'encodeVolumeGrid');
  const unknownName = names.find(name => !VOLUME_GRID_CHANNELS.includes(name));
  if (unknownName !== undefined) throw new TypeError(`encodeVolumeGrid: channel "${unknownName}" is not one of ${VOLUME_GRID_CHANNELS.join(', ')}`);
  checkGridSize(size ?? undefined, 'encodeVolumeGrid');
  if (!names.includes('density')) throw new TypeError('encodeVolumeGrid: channels needs a "density" channel');
  checkVelocityChannels(names, 'encodeVolumeGrid');
  const voxels = resolution[0] * resolution[1] * resolution[2];
  const header = JSON.stringify({ resolution, channels: names, ...(size ? { size } : {}) });
  const headerBytes = Math.ceil(header.length / 4) * 4;
  const bytes = new Uint8Array(12 + headerBytes + voxels * 2 * names.length);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, VOLUME_GRID_VERSION, true);
  view.setUint32(8, headerBytes, true);
  bytes.set(new TextEncoder().encode(header.padEnd(headerBytes, ' ')), 12);
  names.forEach((name, index) => {
    const source = channels[name];
    if (source.length !== voxels) throw new RangeError(`encodeVolumeGrid: channel "${name}" holds ${source.length} values, expected ${voxels}`);
    const offset = 12 + headerBytes + index * voxels * 2;
    for (let voxel = 0; voxel < voxels; voxel++) view.setUint16(offset + voxel * 2, source instanceof Uint16Array ? source[voxel] : floatToHalf(source[voxel]), true);
  });
  return bytes;
}

/** Reads a grid file into `{ resolution, size, channels: { density: Uint16Array, ... } }`. Throws an error that says what is wrong with the bytes. */
export function decodeVolumeGrid(source, label = 'volume grid') {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.length < 12 || MAGIC.some((value, index) => bytes[index] !== value)) throw new TypeError(`${label} is not a Crucible grid file (it must start with "67VG"); make one with scripts/vdb-to-grid.py`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== VOLUME_GRID_VERSION) throw new RangeError(`${label} is grid file version ${version}; this build reads version ${VOLUME_GRID_VERSION}`);
  const headerBytes = view.getUint32(8, true);
  if (12 + headerBytes > bytes.length) throw new RangeError(`${label} ends inside its header`);
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerBytes)));
  } catch {
    throw new TypeError(`${label} has a header that is not JSON`);
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new TypeError(`${label} header must be a JSON object with resolution and channels`);
  const names = header.channels;
  if (!Array.isArray(names) || names.length === 0 || names.some(name => !VOLUME_GRID_CHANNELS.includes(name)) || new Set(names).size !== names.length) {
    throw new TypeError(`${label} header channels must be a list of ${VOLUME_GRID_CHANNELS.join(', ')}`);
  }
  if (!names.includes('density')) throw new TypeError(`${label} has no density channel`);
  checkVelocityChannels(names, label);
  checkVolumeGridShape(header.resolution, names.length, label);
  const voxels = header.resolution[0] * header.resolution[1] * header.resolution[2];
  const dataStart = 12 + headerBytes;
  if (bytes.length !== dataStart + voxels * 2 * names.length) {
    throw new RangeError(`${label} holds ${bytes.length - dataStart} bytes of data, expected ${voxels * 2 * names.length} for ${header.resolution.join('x')} and ${names.length} channels`);
  }
  checkGridSize(header.size, label);
  const channels = Object.create(null);
  names.forEach((name, index) => {
    const values = new Uint16Array(voxels);
    for (let voxel = 0; voxel < voxels; voxel++) values[voxel] = view.getUint16(dataStart + (index * voxels + voxel) * 2, true);
    channels[name] = values;
  });
  return { resolution: header.resolution.slice(), size: header.size ? header.size.slice() : null, channels };
}

const registry = new Map();
let loader = null;

/** Names a decoded grid (decodeVolumeGrid) or grid file bytes so a volume's `grid` field can refer to it. */
export function registerVolumeGrid(name, source) {
  if (typeof name !== 'string' || name === '') throw new TypeError('registerVolumeGrid needs a non-empty name');
  registry.set(name, source instanceof Uint8Array || source instanceof ArrayBuffer ? decodeVolumeGrid(source, `grid "${name}"`) : source);
}

/** True when a grid is registered under `name` in this process (a grid the loader would fetch is not counted until it is first used). */
export function isVolumeGridRegistered(name) {
  return registry.has(name);
}

/** Sets the function that fetches grid bytes for a name no one registered (the MCP server reads files); it returns bytes or null. */
export function setVolumeGridLoader(load) {
  loader = load;
}

/** The decoded grid a volume's `grid` name refers to. Throws an error that names the field when nothing is registered. */
export function findVolumeGrid(name, label) {
  const registered = registry.get(name);
  if (registered) return registered;
  const bytes = loader ? loader(name) : null;
  if (bytes) {
    registerVolumeGrid(name, bytes);
    return registry.get(name);
  }
  throw new RangeError(`${label}.grid "${name}" is not loaded: call registerVolumeGrid("${name}", bytes) with the contents of a grid file made by scripts/vdb-to-grid.py`);
}

const decodedByGrid = new WeakMap();

let halfFloatLookup = null;

// Every half float bit pattern as a float, built once for the process: a sequence decodes a grid per frame, and building the table for each one cost about as much as the decode.
function halfFloatTable() {
  if (halfFloatLookup) return halfFloatLookup;
  halfFloatLookup = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits++) halfFloatLookup[bits] = halfToFloat(bits);
  return halfFloatLookup;
}

/** The grid's channels as Float32Arrays, decoded once; a missing temperature or flame channel is left out. */
export function volumeGridFloats(grid) {
  let floats = decodedByGrid.get(grid);
  if (floats) return floats;
  floats = Object.create(null);
  const table = halfFloatTable();
  // Only the known channel names become keys, so a name read from a grid file can never write another property.
  for (const name of VOLUME_GRID_CHANNELS) {
    const values = grid.channels[name];
    if (!values) continue;
    const decoded = new Float32Array(values.length);
    for (let index = 0; index < values.length; index++) decoded[index] = table[values[index]];
    floats[name] = decoded;
  }
  decodedByGrid.set(grid, floats);
  return floats;
}

/**
 * Writes the density, temperature and flame at a point of the unit cube into `out`, trilinear with texel centres at (i + 0.5) / n and 0 beyond the grid's faces,
 * as an OpenVDB grid reads (the rasterizer's textures have a border of empty voxels, GRID_BORDER_VOXELS, for the same ramp). A channel the grid lacks reads 0,
 * and `flame` reads the density when there is no flame channel. With `baked` (bakedGridEmission) the blackbody radiance at the point goes to out[3] to out[5],
 * interpolated after the blackbody, so the field is what Cycles' one linear tap averages to and the fourth power of the blackbody never amplifies the crease of
 * an interpolated temperature (#1752). `out` then needs six entries.
 */
export function sampleVolumeGrid(floats, resolution, u, v, w, out, baked = null) {
  gatherCorners(resolution, u, v, w);
  out[0] = mixCorners(floats.density);
  out[1] = mixCorners(floats.temperature);
  out[2] = mixCorners(floats.flame ?? floats.density);
  if (baked) {
    out[3] = mixCorners(baked.red);
    out[4] = mixCorners(baked.green);
    out[5] = mixCorners(baked.blue);
  }
  return out;
}

/**
 * How far into the shutter (0 as it opens at the frame's own time, 1 as it closes) march step `step` samples a moving grid: the ray's jitter plus the golden ratio per
 * step, wrapped to 0..1. One sample per step spreads the steps of a ray evenly over the shutter, so the blur costs one velocity tap per step and no extra density taps;
 * the fog shader repeats this (fog-shader.js, localGridTimeFraction).
 */
export const GRID_MOTION_TIME_STEP = 0.618034;
export function gridMotionTimeFraction(jitter, step) {
  const position = jitter + step * GRID_MOTION_TIME_STEP;
  return position - Math.floor(position);
}

/** True when the grid carries the three velocity channels (VOLUME_GRID_VELOCITY_CHANNELS) that a volume's motion blur reads. */
export function hasGridVelocity(grid) {
  return Boolean(grid.channels.velocityX);
}

const unitVelocityByGrid = new WeakMap();

/**
 * The grid's velocity as the fraction of the box crossed per second along each axis, as three Float32Arrays (`x`, `y`, `z`) in voxel order, decoded once per grid
 * and size, or null for a grid with no velocity channels. The channels are in header-size units per second; a grid with no header size takes `fallbackSize`,
 * the box the volume draws it in, so a gas that crosses half the box in a second reads 0.5 either way.
 */
export function gridUnitVelocity(grid, fallbackSize) {
  if (!hasGridVelocity(grid)) return null;
  const size = grid.size ?? fallbackSize;
  if (!size) throw new RangeError('gridUnitVelocity: a grid with velocity needs a header size or a volume size to turn its velocity into box fractions per second');
  const cached = unitVelocityByGrid.get(grid);
  if (cached?.key === size.join(',')) return cached.velocity;
  const floats = volumeGridFloats(grid);
  const velocity = { x: floats.velocityX.map(value => value / size[0]), y: floats.velocityY.map(value => value / size[1]), z: floats.velocityZ.map(value => value / size[2]) };
  unitVelocityByGrid.set(grid, { key: size.join(','), velocity });
  return velocity;
}

/** Writes the unit velocity (gridUnitVelocity) at a point of the unit cube into `out[0..2]`, trilinear like sampleVolumeGrid and 0 beyond the faces. */
export function sampleVolumeGridVelocity(unitVelocity, resolution, u, v, w, out) {
  gatherCorners(resolution, u, v, w);
  out[0] = mixCorners(unitVelocity.x);
  out[1] = mixCorners(unitVelocity.y);
  out[2] = mixCorners(unitVelocity.z);
  return out;
}

const cornerVoxel = new Int32Array(8);
const cornerWeight = new Float64Array(8);

// The eight voxels around a point and their trilinear weights; a voxel beyond the grid, or with weight 0, is -1 and reads 0.
function gatherCorners(resolution, u, v, w) {
  const x = u * resolution[0] - 0.5;
  const y = v * resolution[1] - 0.5;
  const z = w * resolution[2] - 0.5;
  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  const baseZ = Math.floor(z);
  const fractionX = x - baseX;
  const fractionY = y - baseY;
  const fractionZ = z - baseZ;
  for (let corner = 0; corner < 8; corner++) {
    const stepX = corner & 1;
    const stepY = (corner >> 1) & 1;
    const stepZ = (corner >> 2) & 1;
    const voxelX = baseX + stepX;
    const voxelY = baseY + stepY;
    const voxelZ = baseZ + stepZ;
    const weight = (stepX ? fractionX : 1 - fractionX) * (stepY ? fractionY : 1 - fractionY) * (stepZ ? fractionZ : 1 - fractionZ);
    const inside = voxelX >= 0 && voxelY >= 0 && voxelZ >= 0 && voxelX < resolution[0] && voxelY < resolution[1] && voxelZ < resolution[2];
    cornerVoxel[corner] = inside && weight !== 0 ? voxelX + resolution[0] * (voxelY + resolution[1] * voxelZ) : -1;
    cornerWeight[corner] = weight;
  }
}

function mixCorners(data) {
  if (!data) return 0;
  let total = 0;
  for (let corner = 0; corner < 8; corner++) {
    const voxel = cornerVoxel[corner];
    if (voxel >= 0) total += cornerWeight[corner] * data[voxel];
  }
  return total;
}

const bakedEmissionByGrid = new WeakMap();
const temperatureByGrid = new WeakMap();

/** Blender's flame cut-off: a voxel with a flame value at or below it is cold (rna_fluid.cc, where the flame grid becomes the temperature grid). */
export const FLAME_TEMPERATURE_THRESHOLD = 0.01;

/** The temperature of one voxel from its flame as Blender remaps it: `flame > 0.01 ? ignition + flame * (maximum - ignition) : 0`, in temperature units. */
export function flameToTemperature(flame, flameTemperature) {
  return flame > FLAME_TEMPERATURE_THRESHOLD ? flameTemperature.ignition + flame * (flameTemperature.maximum - flameTemperature.ignition) : 0;
}

/**
 * The temperature channel a grid volume emits from: the grid's own, or with `flameTemperature` ({ ignition, maximum }) the flame channel remapped by
 * flameToTemperature, so every voxel with flame sits between the ignition and the maximum however thin its smoke. Float32Array, decoded once per grid and
 * remap; undefined when the grid lacks the source channel.
 */
export function gridTemperature(grid, flameTemperature = null) {
  if (!flameTemperature) return volumeGridFloats(grid).temperature;
  const key = `${flameTemperature.ignition}|${flameTemperature.maximum}`;
  let byRemap = temperatureByGrid.get(grid);
  if (!byRemap) temperatureByGrid.set(grid, byRemap = new Map());
  if (!byRemap.has(key)) {
    const flame = volumeGridFloats(grid).flame;
    byRemap.set(key, flame ? flame.map(value => flameToTemperature(value, flameTemperature)) : undefined);
  }
  return byRemap.get(key);
}

/**
 * The blackbody radiance of every voxel's temperature times `temperatureScale`, as three Float32Arrays (`red`, `green`, `blue`) with the grid's voxel order,
 * decoded once per grid, scale and flame remap (gridTemperature). Values past the half float limit (HALF_FLOAT_MAXIMUM, above about 35,000 K) are
 * clamped by the rasterizer's upload. The blackbody intensity and emission strength stay uniforms. A grid without the source channel bakes to all zeros.
 */
export function bakedGridEmission(grid, temperatureScale, flameTemperature = null) {
  const remapKey = flameTemperature ? `${flameTemperature.ignition}|${flameTemperature.maximum}` : '';
  const cached = bakedEmissionByGrid.get(grid);
  if (cached?.temperatureScale === temperatureScale && cached.remapKey === remapKey) return cached;
  const temperature = gridTemperature(grid, flameTemperature);
  const voxels = grid.resolution[0] * grid.resolution[1] * grid.resolution[2];
  const baked = { temperatureScale, remapKey, red: new Float32Array(voxels), green: new Float32Array(voxels), blue: new Float32Array(voxels) };
  const radiance = [0, 0, 0];
  if (temperature) {
    for (let voxel = 0; voxel < voxels; voxel++) {
      if (!(temperature[voxel] > 0)) continue;
      blackbodyRadiance(temperature[voxel] * temperatureScale, radiance);
      baked.red[voxel] = radiance[0];
      baked.green[voxel] = radiance[1];
      baked.blue[voxel] = radiance[2];
    }
  }
  bakedEmissionByGrid.set(grid, baked);
  return baked;
}

/** Writes the linear RGB radiance of a blackbody at `kelvin` into `out` (zero at 0 K or below): sigma * T^4 / pi times the luminance 1 hue. See BLACKBODY_RADIANCE_SCALE. */
export function blackbodyRadiance(kelvin, out) {
  if (!(kelvin > 0)) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const position = Math.min(Math.max(kelvin - BLACKBODY_TABLE_FIRST_KELVIN, 0) / BLACKBODY_TABLE_STEP_KELVIN, BLACKBODY_TABLE_COUNT - 1);
  const lower = Math.min(Math.floor(position), BLACKBODY_TABLE_COUNT - 2);
  const blend = position - lower;
  const scale = BLACKBODY_RADIANCE_SCALE * kelvin ** 4;
  for (let channel = 0; channel < 3; channel++) {
    const low = BLACKBODY_HUE_TABLE[lower * 3 + channel];
    const high = BLACKBODY_HUE_TABLE[(lower + 1) * 3 + channel];
    out[channel] = (low + (high - low) * blend) * scale;
  }
  return out;
}
