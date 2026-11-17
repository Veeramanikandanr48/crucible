import { MAX_LOCAL_VOLUMES, LOCAL_VOLUME_MAXIMUM_STEPS, ONE_GRID_VOLUME_MESSAGE, resolveLocalVolumesWith } from './local-volume-resolve.js';
import { localVolumeFractalNoise } from './local-volume-noise.js';
import { sampleVolumeGrid, sampleVolumeGridVelocity, gridUnitVelocity, bakedGridEmission, volumeGridFloats } from './volume-grid.js';
import { LOCAL_VOLUME_RAMP_STOPS, rampSourceCode, resolveEmissionRamp } from './local-volume-ramp.js';
import { bakeEmissionRamp } from './local-volume-ramp-bake.js';
import { resolveGridVolume, LOCAL_VOLUME_GRID_MAXIMUM_STEPS } from './local-volume-grid.js';

export * from './local-volume-resolve.js';
export { LOCAL_VOLUME_GRID_MAXIMUM_STEPS };

/**
 * Checks a list of local volumes and returns them with every default filled in, grid volumes included. Throws an error that names the field.
 * The scene entry calls resolveLocalVolumesWith instead, so the grid resolver loads with the grid module and not with every scene.
 */
export function resolveLocalVolumes(input, label = 'localVolumes') {
  return resolveLocalVolumesWith(resolveGridVolume, input, label, resolveEmissionRamp);
}

/** The uniform arrays the post shader reads, one vec4 per volume. Pass resolved volumes. */
export function createLocalVolumeBuffers() {
  const size = MAX_LOCAL_VOLUMES * 4;
  return { count: 0, blurred: false, meshParts: [], grid: new Float32Array(size), gridVolume: null, gridShutter: 0, kind: 'both', noiseOctaves: false, centers: new Float32Array(size), extents: new Float32Array(size), absorption: new Float32Array(size), emission: new Float32Array(size), steps: new Float32Array(size), axes: new Float32Array(size * 3), rampSetup: new Float32Array(size), rampColors: new Float32Array(size * LOCAL_VOLUME_RAMP_STOPS) };
}

// The emission ramp of volume `index` (#1046): rampSetup holds x the source code (0 none), y the stop count and z, w the source range; rampColors
// holds the baked stops, one vec4 each, with the exposure and the emission strength already applied.
function packEmissionRamp(volume, index, buffers) {
  const { emissionRamp } = volume;
  const baked = bakeEmissionRamp(emissionRamp);
  buffers.rampSetup.set([rampSourceCode(emissionRamp.source), baked.count, ...emissionRamp.range], index * 4);
  for (let stop = 0; stop < baked.count; stop++) {
    const at = (index * LOCAL_VOLUME_RAMP_STOPS + stop) * 4;
    for (let channel = 0; channel < 3; channel++) buffers.rampColors[at + channel] = baked.colors[stop * 3 + channel] * volume.emissionStrength;
  }
}

const IDENTITY_AXES = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

// The w of a packed centre tells the shader how to find the volume: 0 a box, 1 a sphere, 2 a closed mesh read from the mesh pass.
export const PACKED_SHAPE_MESH = 2;

export function packLocalVolumes(volumes, buffers) {
  if (volumes.some(volume => volume.shape === 'mesh' && !volume.center)) throw new RangeError('A mesh volume names a part: bind it with bindLocalVolumeParts before packing');
  if (volumes.some(volume => volume.shape === 'grid' && !volume.gridData)) throw new RangeError('Bind a grid volume with bindLocalVolumeParts before packing');
  buffers.count = volumes.length;
  buffers.meshParts = [];
  buffers.gridVolume = null;
  buffers.gridShutter = 0;
  // Which march the frame needs (#1768): a mesh volume needs neither.
  const hasGrid = volumes.some(volume => volume.shape === 'grid');
  const hasShape = volumes.some(volume => volume.shape !== 'grid' && !volume.part);
  buffers.kind = hasGrid && !hasShape ? 'grid' : (hasShape && !hasGrid ? 'shape' : 'both');
  buffers.noiseOctaves = volumes.some(volume => volume.shape !== 'grid' && volume.noiseAmount > 0 && volume.noiseOctaves > 1);
  buffers.grid.fill(0);
  buffers.rampSetup.fill(0);
  buffers.blurred = volumes.some(volume => volume.blur > 0 && volume.density > 0);
  // A volume that glows is composited before bloom extraction, so its glow blooms (#1046).
  buffers.emissive = volumes.some(volume => volume.emissionStrength > 0 && (volume.shape === 'grid' || volume.emission.some(channel => channel > 0)));
  volumes.forEach((volume, index) => {
    const at = index * 4;
    const half = volume.shape === 'sphere' ? [volume.radius, volume.radius, volume.radius] : volume.size.map(extent => extent / 2);
    const packedShape = volume.shape === 'sphere' ? 1 : volume.part ? PACKED_SHAPE_MESH : 0;
    buffers.centers.set([...volume.center, packedShape], at);
    buffers.extents.set([...half, volume.falloff], at);
    buffers.absorption.set([...volume.absorption.map(channel => channel * volume.density), volume.noiseAmount], at);
    buffers.emission.set([...volume.emission.map(channel => channel * volume.emissionStrength), volume.noiseScale], at);
    buffers.steps.set([volume.steps, packedShape === PACKED_SHAPE_MESH ? buffers.meshParts.length : 0, volume.scatter ?? 0, volume.blur ?? 0], at);
    if (volume.emissionRamp) packEmissionRamp(volume, index, buffers);
    if (packedShape === PACKED_SHAPE_MESH) buffers.meshParts.push({ part: volume.part, label: `environment.localVolumes[${index}]` });
    if (volume.shape !== 'grid') {
      buffers.grid[at + 1] = volume.shadowDetail ? 1 : 0;
      buffers.grid[at + 2] = volume.castShadow === true ? 1 : 0;
    }
    if (volume.shape === 'grid') {
      if (buffers.gridVolume) throw new RangeError(ONE_GRID_VOLUME_MESSAGE);
      buffers.gridVolume = volume;
      buffers.gridShutter = volume.motionShutter ?? 0;
      buffers.grid.set([volume.castShadow === true ? 2 : 1, volume.temperatureScale, volume.blackbodyIntensity * volume.emissionStrength, volume.anisotropy], at);
    }
    const axes = volume.axes ?? IDENTITY_AXES;
    // The free fourth component of the first axis row carries the number of scatter octaves and that of the second the noise octaves, each beyond the first.
    for (let axis = 0; axis < 3; axis++) buffers.axes.set([axes[axis * 3], axes[axis * 3 + 1], axes[axis * 3 + 2], axis === 0 ? (volume.scatterOctaves ?? 1) - 1 : (axis === 1 ? (volume.noiseOctaves ?? 1) - 1 : 0)], (index * 3 + axis) * 4);
  });
  return buffers;
}

/**
 * How much the key light of a scattering volume is scaled over the single-scatter estimate. A smoke thick enough to show form scatters the sun many times
 * and reads about as bright as a surface in the same sun, which one isotropic scatter (1 / 4 pi of the key colour) leaves far too dark; the gain keeps the
 * sunlit side clearly above the shaded side. The rasterizer and the CPU path tracer both apply it.
 */
export const LOCAL_VOLUME_KEY_GAIN = 3;

/**
 * How much the faded outer share of a volume counts toward the depth the light crosses: the profile used for the sun and sky depth is
 * `min(profile * saturation, 1)`. The many scatters of a real smoke spread light through its thin fringe as through its body, so a sun
 * ray running along the faded top or side skin is shaded by the whole volume, not by the skin's low density. With the plain profile that
 * skin is lit far above the core and reads as a bright rim around the form.
 */
export const LOCAL_VOLUME_LIGHT_DEPTH_SATURATION = 6;

/**
 * How many times the volume's own depth toward the sun counts in the key light's attenuation. Counting it more than once keeps the shaded
 * side of the smoke clearly darker than the sunlit side, the way the many scatters of a real smoke take the light from its shade.
 */
export const LOCAL_VOLUME_SHADOW_STRENGTH = 1.2;

/**
 * The octave sum that approximates multiple scattering in a volume with `scatterOctaves` above 1 (Wrenninge et al. 2015, "Oz: the great and volumetric"), the one `volumeFog` has:
 * octave n scatters MULTI_SCATTER^n as much, sees MULTI_EXTINCTION^n of the light's optical depth and has MULTI_ANISOTROPY^n of the anisotropy.
 */
export const LOCAL_VOLUME_MULTI_SCATTER = 0.5;
export const LOCAL_VOLUME_MULTI_EXTINCTION = 0.5;
export const LOCAL_VOLUME_MULTI_ANISOTROPY = 0.5;

/** How many taps along the key light measure the optical depth a volume puts between a surface and the sun (#1047). */
export const LOCAL_VOLUME_SURFACE_SHADOW_TAPS = 8;


/** The taps along the light of a volume with `shadowDetail` (the others take 3), so the shadow follows the noise and not only the smooth profile. The shader's loop is bounded by the same number. */
export const LOCAL_VOLUME_DETAIL_SHADOW_TAPS = 8;

/** The share of the mean sky radiance the sky term of a scattering volume keeps. The sky lights the whole volume evenly, so a high share flattens the form the sun gives it. */
export const LOCAL_VOLUME_SKY_GAIN = 0.5;

/**
 * The widest blur, in pixels of a 540 row frame (it scales with the frame height), that the light behind a volume gets: the radius grows as
 * `cap * (1 - exp(-LOCAL_VOLUME_BLUR_RATE * opticalDepth))`, so none at zero depth, most of the cap by an optical depth of 1.5, and it never passes the cap. A thick volume hides the
 * background anyway, a thin one shows it blurred (#855).
 */
export const LOCAL_VOLUME_BLUR_PIXELS = 24;

/** How fast the blur grows with optical depth: a thin wisp of optical depth 0.7 already blurs by about 15 px, so a haze visibly softens the horizon behind it (#855). */
export const LOCAL_VOLUME_BLUR_RATE = 1.5;

/** Samples the march takes per cell of the density noise at least: fewer step over whole cells and the dither of the start offset shows as pixel-pitch grain (#855). */
export const LOCAL_VOLUME_STEPS_PER_NOISE_CELL = 2;

/** The most samples a ray takes through a volume whose noise has several octaves: its finest cell is 2^(octaves - 1) times smaller, so the cap of LOCAL_VOLUME_MAXIMUM_STEPS undercounts it (#1855). */
export const LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS = 96;

/**
 * The samples a ray of `chord` length needs for noise of `octaves` octaves at base `scale`: LOCAL_VOLUME_STEPS_PER_NOISE_CELL per cell of the finest
 * octave (scale * 2^(octaves - 1), lacunarity 2), at most LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS. The post shader repeats the rule.
 */
export function localVolumeOctaveStepCount(octaves, scale, chord) {
  const finestScale = scale * 2 ** (octaves - 1);
  return Math.min(LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS, Math.ceil(chord * finestScale * LOCAL_VOLUME_STEPS_PER_NOISE_CELL));
}

/**
 * The samples a ray takes through a noisy volume: the volume's `steps`, raised so that each noise cell along `length` gets
 * LOCAL_VOLUME_STEPS_PER_NOISE_CELL of them, up to LOCAL_VOLUME_MAXIMUM_STEPS (LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS counted from the finest octave
 * when noiseOctaves is above 1). Without noise it is `steps`. The post shader repeats the rule.
 */
export function localVolumeStepCount(volume, length) {
  if (!(volume.noiseAmount > 0)) return volume.steps;
  if (volume.noiseOctaves > 1) return Math.max(volume.steps, localVolumeOctaveStepCount(volume.noiseOctaves, volume.noiseScale, length));
  const cellSteps = Math.ceil(length * volume.noiseScale * LOCAL_VOLUME_STEPS_PER_NOISE_CELL);
  return Math.min(LOCAL_VOLUME_MAXIMUM_STEPS, Math.max(volume.steps, cellSteps));
}

/**
 * How much of the sun's elevation the depth toward the sun keeps (1 is the true direction). A low sun lights a smoke box through its top face as
 * quickly as through its side, so with the true direction the top edge glows as bright as the sunward edge and the gradient across the form is lost;
 * flattening the direction measures the depth the light crosses sideways, as the many scatters of a real smoke spread it. Above 0 so a sun straight
 * overhead keeps a direction.
 */
export const LOCAL_VOLUME_SUN_FLATTEN = 0.1;

function fadeProfile(ratio) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return 1 - clamped * clamped * (3 - 2 * clamped);
}

/**
 * How far the noise pushes the faded edge of a volume in and out, as a share of the fade width, at its largest (#855). The fade is a smooth
 * ramp from the core to the edge of the form, so without this a box or a sphere keeps a flat top and flat sides under the noise and reads as
 * a rounded rectangle, not a cloud. The push is zero at the core and at the outer face, so the core stays as thick and no step shows where the form ends.
 */
export const LOCAL_VOLUME_EDGE_WARP = 1;

/** The fade position (0 at the core, 1 at the outer face) after the noise has pushed the edge: `position` moved by the noise, most at the middle of the fade. */
export function warpedFadePosition(position, noiseAmount, noise) {
  const clamped = Math.min(1, Math.max(0, position));
  return clamped + (0.5 - noise) * noiseAmount * LOCAL_VOLUME_EDGE_WARP * 4 * clamped * (1 - clamped);
}

const gridScratch = new Float64Array(3);
const velocityScratch = new Float64Array(3);

/**
 * Writes into `out` the point a motion-blurred grid volume reads instead of (x, y, z) (#1759). The frame's grid is the gas as the shutter opens, and the gas moves on by its
 * velocity, so the point seen `timeFraction * motionShutter` seconds into the shutter reads the grid back along the velocity there: the sum over the shutter is a smear that
 * leads the gas, which is what Cycles does with a velocity grid (measured on the #1735 blast, docs/volumetric.md). A volume with no `motionShutter`, and a point outside the
 * box (no gas, no velocity), read where they are.
 */
export function localVolumeGridMotionPoint(volume, x, y, z, timeFraction, out) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  if (!(volume.motionShutter > 0)) return out;
  const unitX = (x - volume.center[0]) / volume.size[0] + 0.5;
  const unitY = (y - volume.center[1]) / volume.size[1] + 0.5;
  const unitZ = (z - volume.center[2]) / volume.size[2] + 0.5;
  if (unitX < 0 || unitX > 1 || unitY < 0 || unitY > 1 || unitZ < 0 || unitZ > 1) return out;
  sampleVolumeGridVelocity(gridUnitVelocity(volume.gridData, volume.size), volume.gridData.resolution, unitX, unitY, unitZ, velocityScratch);
  const seconds = volume.motionShutter * timeFraction;
  out[0] -= velocityScratch[0] * volume.size[0] * seconds;
  out[1] -= velocityScratch[1] * volume.size[1] * seconds;
  out[2] -= velocityScratch[2] * volume.size[2] * seconds;
  return out;
}

/**
 * Writes the density, temperature and flame of a grid volume at a world point into `out` (all 0 outside its box) and returns it. With `withBlackbody`, `out` has
 * six entries and out[3] to out[5] get the baked blackbody radiance there, before the blackbody intensity and emission strength (see sampleVolumeGrid).
 */
export function localVolumeGridSample(volume, x, y, z, out, withBlackbody = false) {
  const unitX = (x - volume.center[0]) / volume.size[0] + 0.5;
  const unitY = (y - volume.center[1]) / volume.size[1] + 0.5;
  const unitZ = (z - volume.center[2]) / volume.size[2] + 0.5;
  if (unitX < 0 || unitX > 1 || unitY < 0 || unitY > 1 || unitZ < 0 || unitZ > 1) {
    out.fill(0);
    return out;
  }
  const baked = withBlackbody ? bakedGridEmission(volume.gridData, volume.temperatureScale) : null;
  return sampleVolumeGrid(volumeGridFloats(volume.gridData), volume.gridData.resolution, unitX, unitY, unitZ, out, baked);
}

/** The density factor of a volume at a point: 1 at the core, fading over the outer `falloff` share, times the noise factor (up to 2) when `noiseAmount` is above 0, as the post shader does. With noise the fade edge is also pushed in and out (LOCAL_VOLUME_EDGE_WARP). */
export function localVolumeProfile(volume, x, y, z, withNoise = true) {
  if (volume.shape === 'mesh') return 1;
  if (volume.gridData) return localVolumeGridSample(volume, x, y, z, gridScratch)[0];
  let offsetX = x - volume.center[0];
  let offsetY = y - volume.center[1];
  let offsetZ = z - volume.center[2];
  if (volume.axes) {
    const axes = volume.axes;
    const alongX = axes[0] * offsetX + axes[1] * offsetY + axes[2] * offsetZ;
    const alongY = axes[3] * offsetX + axes[4] * offsetY + axes[5] * offsetZ;
    offsetZ = axes[6] * offsetX + axes[7] * offsetY + axes[8] * offsetZ;
    offsetX = alongX;
    offsetY = alongY;
  }
  const noisy = withNoise && volume.noiseAmount > 0;
  const noise = noisy ? localVolumeFractalNoise(x * volume.noiseScale, y * volume.noiseScale, z * volume.noiseScale, volume.noiseOctaves) : 0.5;
  let profile = 1;
  if (volume.shape === 'sphere') {
    const distance = Math.hypot(offsetX, offsetY, offsetZ) / volume.radius;
    if (distance >= 1) return 0;
    if (volume.falloff > 0) profile = fadeProfile(warpedFadePosition((distance - (1 - volume.falloff)) / volume.falloff, noisy ? volume.noiseAmount : 0, noise));
  } else {
    const ratioX = Math.abs(offsetX) / (volume.size[0] / 2);
    const ratioY = Math.abs(offsetY) / (volume.size[1] / 2);
    const ratioZ = Math.abs(offsetZ) / (volume.size[2] / 2);
    if (Math.max(ratioX, ratioY, ratioZ) >= 1) return 0;
    if (volume.falloff > 0) {
      // The distance past the core box, which is round at the corners: the plain largest ratio fades along boxes with mitred creases.
      const core = 1 - volume.falloff;
      const fadeDistance = Math.hypot(Math.max(ratioX - core, 0), Math.max(ratioY - core, 0), Math.max(ratioZ - core, 0));
      profile = fadeProfile(warpedFadePosition(fadeDistance / volume.falloff, noisy ? volume.noiseAmount : 0, noise));
    }
  }
  if (noisy) profile *= 1 + (2 * noise - 1) * volume.noiseAmount;
  return profile;
}

/** Where a ray is inside a volume, as distances along it: writes `[entry, exit]` into `out`, clipped to `[0, limit]`, and returns true; false when it misses. */
export function localVolumeInterval(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  let entry = 0;
  let exit = limit;
  if (volume.shape === 'sphere') {
    const offsetX = originX - volume.center[0];
    const offsetY = originY - volume.center[1];
    const offsetZ = originZ - volume.center[2];
    const along = offsetX * directionX + offsetY * directionY + offsetZ * directionZ;
    const discriminant = along * along - (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - volume.radius * volume.radius);
    if (discriminant <= 0) return false;
    const root = Math.sqrt(discriminant);
    entry = Math.max(entry, -along - root);
    exit = Math.min(exit, -along + root);
  } else {
    const axes = volume.axes;
    const offsetX = originX - volume.center[0];
    const offsetY = originY - volume.center[1];
    const offsetZ = originZ - volume.center[2];
    for (let axis = 0; axis < 3; axis++) {
      const origin = axis === 0 ? originX : axis === 1 ? originY : originZ;
      let direction = axis === 0 ? directionX : axis === 1 ? directionY : directionZ;
      let relative = volume.center[axis] - origin;
      if (axes) {
        const at = axis * 3;
        relative = -(axes[at] * offsetX + axes[at + 1] * offsetY + axes[at + 2] * offsetZ);
        direction = axes[at] * directionX + axes[at + 1] * directionY + axes[at + 2] * directionZ;
      }
      const halfSize = volume.size[axis] / 2;
      if (direction === 0) {
        if (Math.abs(relative) > halfSize) return false;
        continue;
      }
      const first = (relative - halfSize) / direction;
      const second = (relative + halfSize) / direction;
      entry = Math.max(entry, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
  }
  if (!(entry < exit)) return false;
  out[0] = entry;
  out[1] = exit;
  return true;
}

/** How many taps along the key light measure the optical depth a grid volume puts between a surface and the sun: more than a box takes, because a simulated density has structure along the ray that a smooth profile does not. */
export const LOCAL_VOLUME_GRID_SHADOW_TAPS = 16;
