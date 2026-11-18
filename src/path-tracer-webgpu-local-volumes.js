import { LOCAL_VOLUME_KEY_GAIN, LOCAL_VOLUME_LIGHT_DEPTH_SATURATION, LOCAL_VOLUME_SHADOW_STRENGTH, LOCAL_VOLUME_SKY_GAIN, LOCAL_VOLUME_SUN_FLATTEN, LOCAL_VOLUME_EDGE_WARP, LOCAL_VOLUME_STEPS_PER_NOISE_CELL } from './local-volumes.js';
import { LOCAL_VOLUME_MAXIMUM_STEPS, MAX_LOCAL_VOLUMES } from './local-volume-resolve.js';
import { LOCAL_VOLUME_RAMP_STOPS, rampSourceCode } from './local-volume-ramp.js';
import { bakeEmissionRamp } from './local-volume-ramp-bake.js';
import { meanEnvironmentRadiance } from './path-tracer-volume.js';
import { bakedGridEmission, GRID_MOTION_TIME_STEP, gridUnitVelocity, volumeGridFloats } from './volume-grid.js';
import { STEP_INTEGRAL_WGSL } from './volume-step-integral.js';
import { packNodes } from './path-tracer-gpu-pack.js';

// Local volumes (environment.localVolumes: boxes and spheres of absorbing, emitting and scattering medium) on the WebGPU path
// tracer (#1048). The WGSL is the march of createLocalVolumeCrossing in path-tracer-volume.js: the same step count, jittered
// midpoints, profile with falloff and noise, and the same sun and sky terms for a scattering volume, so the two tracers draw one
// picture and differ by noise only. The march is spliced into the megakernel only for a scene that has volumes.
// A mesh volume (#2004) carries its own triangles and BVH in a block at the end of the buffer and is marched over the inside segments of the closed mesh, as the CPU tracer does. A grid volume (#1785) rides in the same buffer after the
// table: the megakernel's one bind group holds storage buffers only, so the voxels are float vectors read with the trilinear weights of
// sampleVolumeGrid, not a 3D texture. The motion blur reads each step at its shutter time, as the CPU tracer does.

/** Vectors per volume in the table, and the two header vectors in front of them. */
export const LOCAL_VOLUME_TEXELS = 8;
export const LOCAL_VOLUME_HEADER_TEXELS = 2;
/** The shape code of a grid volume in the table (box 0, sphere 1). Negative so the box and sphere tests of the kernel never match it. */
export const LOCAL_VOLUME_GRID_SHAPE = -1;
/** The shape code of a mesh volume in the table. */
export const LOCAL_VOLUME_MESH_SHAPE = -2;
/** The most triangles the mesh volumes of one scene may hold together: 262144 triangles are about 30 MB of nodes and corners in the volume buffer. */
export const MAX_WEBGPU_MESH_VOLUME_TRIANGLES = 262144;
/** Vectors per triangle of a mesh volume: the corner and the two edges. */
export const MESH_VOLUME_TRIANGLE_TEXELS = 3;
/** The most surface crossings along one ray and the most inside segments they make (MAXIMUM_MESH_CROSSINGS and MAXIMUM_MESH_SEGMENTS of path-tracer-volume.js). */
export const MESH_VOLUME_MAXIMUM_CROSSINGS = 64;
/** A crossing at a distance cannot be told from the surface it left by less than this fraction of the volume's diagonal (the CPU tracer steps 1e-6 in 64 bit; 32 bit needs more). */
export const MESH_VOLUME_STEP_OFFSET_FRACTION = 1e-5;
/** Vectors of one emission ramp in the ramp block: the source, stop count and range, the emission strength, then up to LOCAL_VOLUME_RAMP_STOPS colours. */
export const LOCAL_VOLUME_RAMP_TEXELS = 2 + LOCAL_VOLUME_RAMP_STOPS;
/** Vectors in front of a grid's voxels: the resolution and blackbody weight, then the shutter, the two optional channel flags and the voxel stride. */
export const LOCAL_VOLUME_GRID_HEADER_TEXELS = 2;

const IDENTITY_AXES = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Throws for a volume the WebGPU tracer cannot draw; does nothing for a scene without volumes. A mesh volume has to come prepared (its part bound and its BVH built by the trace scene). */
export function assertWebGpuLocalVolumes(scene) {
  scene.localVolumes?.forEach((volume, index) => {
    if (volume.part && !volume.mesh) {
      throw new RangeError(`environment.localVolumes[${index}] is a mesh volume that was not prepared for tracing; build the scene with buildTraceScene, which builds its BVH, or use fit "bounds".`);
    }
  });
}

/** The optional WGSL parts a scene's volumes need, as the kernel variant flags; a part is spliced in only when a volume uses it. */
export function webGpuVolumeFeatures(volumes) {
  return {
    hasGridVolume: Boolean(volumes?.some(volume => volume.shape === 'grid')),
    hasNoiseOctaves: Boolean(volumes?.some(volume => volume.noiseAmount > 0 && volume.noiseOctaves > 1)),
    hasEmissionRamp: Boolean(volumes?.some(volume => volume.emissionRamp)),
    hasMeshVolume: Boolean(volumes?.some(volume => volume.mesh)),
  };
}

/**
 * The volume table for the WebGPU kernel: a header (the count, then the mean sky radiance that lights scattering volumes)
 * followed by eight vectors per volume:
 *   0 centre, shape (0 box, 1 sphere)   1 half extents, falloff   2 absorption times density, noise amount
 *   3 emission times strength, noise scale   4 steps, scatter, anisotropy, radius   5-7 the three rows of the box axes.
 * A mesh volume has shape code LOCAL_VOLUME_MESH_SHAPE and its number among the mesh volumes in the radius slot of vector 4; its table row is otherwise a box's, so the same fields set its steps, absorption and emission.
 * The second float of the header is the vector index of the mesh block, relative to the table (0 without mesh volumes); the mesh block is the last block of the buffer.
 * The fourth float of vector 5 is the noise octaves minus one and that of vector 7 is the ramp number plus one (0 for no ramp); a ramp block follows the table
 * and the grid block (packWebGpuEmissionRamps).
 */
export function packWebGpuLocalVolumes(volumes, environment) {
  if (volumes.length > MAX_LOCAL_VOLUMES) throw new RangeError(`The WebGPU path tracer holds at most ${MAX_LOCAL_VOLUMES} local volumes, got ${volumes.length}`);
  const rampVolumes = volumes.filter(volume => volume.emissionRamp);
  const meshVolumes = volumes.filter(volume => volume.mesh);
  const table = new Float32Array((LOCAL_VOLUME_HEADER_TEXELS + volumes.length * LOCAL_VOLUME_TEXELS) * 4);
  table.set([volumes.length, 0, 0, 0], 0);
  table.set([...meanEnvironmentRadiance(environment), 0], 4);
  volumes.forEach((volume, index) => {
    const at = (LOCAL_VOLUME_HEADER_TEXELS + index * LOCAL_VOLUME_TEXELS) * 4;
    const isSphere = volume.shape === 'sphere';
    const isGrid = volume.shape === 'grid';
    const isMesh = Boolean(volume.mesh);
    const half = isSphere ? [volume.radius, volume.radius, volume.radius] : volume.size.map(extent => extent / 2);
    const axes = volume.axes ?? IDENTITY_AXES;
    table.set([...volume.center, isGrid ? LOCAL_VOLUME_GRID_SHAPE : isMesh ? LOCAL_VOLUME_MESH_SHAPE : isSphere ? 1 : 0], at);
    table.set([...half, volume.falloff], at + 4);
    table.set([...volume.absorption.map(channel => channel * volume.density), volume.noiseAmount], at + 8);
    table.set([...volume.emission.map(channel => channel * volume.emissionStrength), volume.noiseScale], at + 12);
    table.set([volume.steps, volume.scatter ?? 0, volume.anisotropy ?? 0, isSphere ? volume.radius : isMesh ? meshVolumes.indexOf(volume) : 0], at + 16);
    const octavesAfterFirst = (volume.noiseOctaves ?? 1) - 1;
    const rampNumber = volume.emissionRamp ? rampVolumes.indexOf(volume) + 1 : 0;
    for (let row = 0; row < 3; row++) table.set([axes[row * 3], axes[row * 3 + 1], axes[row * 3 + 2], row === 0 ? octavesAfterFirst : row === 2 ? rampNumber : 0], at + 20 + row * 4);
  });
  const gridVolume = volumes.find(volume => volume.shape === 'grid');
  const blocks = [table];
  if (gridVolume) blocks.push(packWebGpuGrid(gridVolume));
  if (rampVolumes.length > 0) blocks.push(packWebGpuEmissionRamps(rampVolumes));
  if (meshVolumes.length > 0) {
    table[1] = blocks.reduce((length, block) => length + block.length, 0) / 4;
    blocks.push(packWebGpuMeshVolumes(meshVolumes));
  }
  return blocks.length === 1 ? table : concatenateFloats(blocks);
}

function concatenateFloats(blocks) {
  const joined = new Float32Array(blocks.reduce((length, block) => length + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    joined.set(block, at);
    at += block.length;
  }
  return joined;
}

/**
 * The ramp block, the last block of the buffer: LOCAL_VOLUME_RAMP_TEXELS vectors per volume that has an emissionRamp, in volume order:
 *   0  source (1 density, 2 temperature, 3 flame), stop count, low end of the range, high end   1  emissionStrength
 *   2 to 9  the baked colours with the exposure applied (bakeEmissionRamp), the unused stops 0.
 */
export function packWebGpuEmissionRamps(rampVolumes) {
  const block = new Float32Array(rampVolumes.length * LOCAL_VOLUME_RAMP_TEXELS * 4);
  rampVolumes.forEach((volume, index) => {
    const at = index * LOCAL_VOLUME_RAMP_TEXELS * 4;
    const baked = bakeEmissionRamp(volume.emissionRamp);
    block.set([rampSourceCode(volume.emissionRamp.source), baked.count, ...volume.emissionRamp.range], at);
    block[at + 4] = volume.emissionStrength;
    for (let stop = 0; stop < baked.count; stop++) block.set(baked.colors.subarray(stop * 3, stop * 3 + 3), at + 8 + stop * 4);
  });
  return block;
}

/**
 * The mesh block, the last block of the buffer: the mesh count, then one descriptor vector per mesh volume, then each mesh's BVH nodes and triangles.
 *   header 0   mesh count, 0, 0, 0
 *   header 1+  node start, triangle start (vector indices from the block), the step offset past a crossing, node count
 *   nodes      two vectors a node as packNodes writes them (minimum and right child or minus the leaf count, maximum and first slot)
 *   triangles  MESH_VOLUME_TRIANGLE_TEXELS vectors a leaf slot: the first corner, then the two edges, in world space
 */
export function packWebGpuMeshVolumes(meshVolumes) {
  const triangleTotal = meshVolumes.reduce((total, volume) => total + volume.mesh.indices.length / 3, 0);
  if (triangleTotal > MAX_WEBGPU_MESH_VOLUME_TRIANGLES) {
    throw new RangeError(`The WebGPU path tracer holds at most ${MAX_WEBGPU_MESH_VOLUME_TRIANGLES} triangles across mesh local volumes, got ${triangleTotal}; simplify the parts or use backend "cpu".`);
  }
  const headerTexels = 1 + meshVolumes.length;
  const sizes = meshVolumes.map(volume => ({ nodes: volume.mesh.bvh.nodeCount * 2, triangles: (volume.mesh.indices.length / 3) * MESH_VOLUME_TRIANGLE_TEXELS }));
  const block = new Float32Array((headerTexels + sizes.reduce((total, size) => total + size.nodes + size.triangles, 0)) * 4);
  block[0] = meshVolumes.length;
  let cursor = headerTexels;
  meshVolumes.forEach((volume, index) => {
    const { positions, indices, bvh } = volume.mesh;
    const diagonal = Math.hypot(...volume.size);
    block.set([cursor, cursor + sizes[index].nodes, diagonal * MESH_VOLUME_STEP_OFFSET_FRACTION, bvh.nodeCount], (1 + index) * 4);
    block.set(packNodes(bvh).data.subarray(0, sizes[index].nodes * 4), cursor * 4);
    const triangleBase = (cursor + sizes[index].nodes) * 4;
    for (let slot = 0; slot < bvh.triangleOrder.length; slot++) {
      const triangle = bvh.triangleOrder[slot];
      const first = indices[triangle * 3] * 3;
      const second = indices[triangle * 3 + 1] * 3;
      const third = indices[triangle * 3 + 2] * 3;
      for (let axis = 0; axis < 3; axis++) {
        block[triangleBase + slot * 12 + axis] = positions[first + axis];
        block[triangleBase + slot * 12 + 4 + axis] = positions[second + axis] - positions[first + axis];
        block[triangleBase + slot * 12 + 8 + axis] = positions[third + axis] - positions[first + axis];
      }
    }
    cursor += sizes[index].nodes + sizes[index].triangles;
  });
  return block;
}

function gridBlockLength(volume) {
  const [width, height, depth] = volume.gridData.resolution;
  return (LOCAL_VOLUME_GRID_HEADER_TEXELS + width * height * depth * gridVoxelStride(volume)) * 4;
}

function gridVoxelStride(volume) {
  return 1 + (volume.blackbodyIntensity > 0 ? 1 : 0) + (volume.motionShutter > 0 ? 1 : 0);
}

/**
 * The grid block that follows the volume table: a header of two vectors, then one run of vectors per voxel (x fastest, then y, then z, the grid file's order):
 *   header 0  resolution x, y, z, blackbody weight (blackbodyIntensity times emissionStrength)
 *   header 1  shutter seconds (0 is off), has baked blackbody, has velocity, vectors per voxel
 *   voxel     density, flame (the density when the grid has no flame channel), the temperature when the volume has an emissionRamp (else 0), 0
 *             then, with blackbodyIntensity above 0, the baked blackbody radiance (bakedGridEmission) as red, green, blue, 0
 *             then, with a shutter open, the unit velocity (gridUnitVelocity: box fractions per second) as x, y, z, 0.
 * A voxel is 16 to 48 bytes, so a 128 cubed grid with all three is about 100 MB: lower the resolution of a grid that does not fit the device's storage buffer.
 */
export function packWebGpuGrid(volume) {
  const { gridData } = volume;
  const [width, height, depth] = gridData.resolution;
  const stride = gridVoxelStride(volume);
  const withBlackbody = volume.blackbodyIntensity > 0;
  const withVelocity = volume.motionShutter > 0;
  const block = new Float32Array(gridBlockLength(volume));
  block.set([width, height, depth, volume.blackbodyIntensity * volume.emissionStrength], 0);
  block.set([volume.motionShutter ?? 0, withBlackbody ? 1 : 0, withVelocity ? 1 : 0, stride], 4);
  const floats = volumeGridFloats(gridData);
  const flame = floats.flame ?? floats.density;
  const temperature = volume.emissionRamp ? floats.temperature : null;
  const baked = withBlackbody ? bakedGridEmission(gridData, volume.temperatureScale, volume.flameTemperature) : null;
  const velocity = withVelocity ? gridUnitVelocity(gridData, volume.size) : null;
  const voxelCount = width * height * depth;
  for (let voxel = 0; voxel < voxelCount; voxel++) {
    let at = (LOCAL_VOLUME_GRID_HEADER_TEXELS + voxel * stride) * 4;
    block[at] = floats.density[voxel];
    block[at + 1] = flame[voxel];
    if (temperature) block[at + 2] = temperature[voxel];
    if (baked) {
      at += 4;
      block.set([baked.red[voxel], baked.green[voxel], baked.blue[voxel]], at);
    }
    if (velocity) {
      at += 4;
      block.set([velocity.x[voxel], velocity.y[voxel], velocity.z[voxel]], at);
    }
  }
  return block;
}

/**
 * The march. `params.seedAndAtlas.w` is the vector index of the table header in the materials buffer. With `hasGrid` the grid march and sampler are
 * spliced in; without it the text is what it was before grids, so a scene without a grid compiles the same kernel. `hasNoiseOctaves` and `hasEmissionRamp`
 * splice the fractal noise and the ramp light the same way, and `hasMesh` the mesh volume march.
 */
export const buildLocalVolumeFunctions = ({ hasGrid = false, hasNoiseOctaves = false, hasEmissionRamp = false, hasMesh = false } = {}) => /* wgsl */ `
${STEP_INTEGRAL_WGSL}
const LOCAL_VOLUME_TEXELS: i32 = ${LOCAL_VOLUME_TEXELS};
const LOCAL_VOLUME_HEADER_TEXELS: i32 = ${LOCAL_VOLUME_HEADER_TEXELS};
const LOCAL_VOLUME_LIMIT: i32 = ${MAX_LOCAL_VOLUMES};
const LOCAL_VOLUME_MAXIMUM_STEPS: f32 = ${LOCAL_VOLUME_MAXIMUM_STEPS}.0;
const LOCAL_VOLUME_STEPS_PER_CELL: f32 = ${LOCAL_VOLUME_STEPS_PER_NOISE_CELL}.0;
const LOCAL_VOLUME_KEY_GAIN: f32 = ${LOCAL_VOLUME_KEY_GAIN}.0;
const LOCAL_VOLUME_DEPTH_SATURATION: f32 = ${LOCAL_VOLUME_LIGHT_DEPTH_SATURATION}.0;
const LOCAL_VOLUME_SHADOW_STRENGTH: f32 = ${LOCAL_VOLUME_SHADOW_STRENGTH};
const LOCAL_VOLUME_SKY_GAIN: f32 = ${LOCAL_VOLUME_SKY_GAIN};
const LOCAL_VOLUME_SUN_FLATTEN: f32 = ${LOCAL_VOLUME_SUN_FLATTEN};
const LOCAL_VOLUME_EDGE_WARP: f32 = ${LOCAL_VOLUME_EDGE_WARP}.0;

var<private> localSpan: vec2<f32>;

fn localVolumeTexel(volume: i32, offset: i32) -> vec4<f32> {
  return materials[i32(params.seedAndAtlas.w) + LOCAL_VOLUME_HEADER_TEXELS + volume * LOCAL_VOLUME_TEXELS + offset];
}

// The value noise of the rasterizer's post shader (local-volume-noise.js).
fn localLatticeHash(cell: vec3<f32>) -> f32 {
  var scrambled = fract(cell * 0.1031);
  let spread = scrambled.x * (scrambled.z + 31.32) + scrambled.y * (scrambled.y + 31.32) + scrambled.z * (scrambled.x + 31.32);
  scrambled += vec3<f32>(spread);
  return fract((scrambled.x + scrambled.y) * scrambled.z);
}

fn localVolumeNoise(position: vec3<f32>) -> f32 {
  let cell = floor(position);
  let fraction = position - cell;
  let smoothed = fraction * fraction * (3.0 - 2.0 * fraction);
  let lower = mix(
    mix(localLatticeHash(cell), localLatticeHash(cell + vec3<f32>(1.0, 0.0, 0.0)), smoothed.x),
    mix(localLatticeHash(cell + vec3<f32>(0.0, 1.0, 0.0)), localLatticeHash(cell + vec3<f32>(1.0, 1.0, 0.0)), smoothed.x),
    smoothed.y);
  let upper = mix(
    mix(localLatticeHash(cell + vec3<f32>(0.0, 0.0, 1.0)), localLatticeHash(cell + vec3<f32>(1.0, 0.0, 1.0)), smoothed.x),
    mix(localLatticeHash(cell + vec3<f32>(0.0, 1.0, 1.0)), localLatticeHash(cell + vec3<f32>(1.0, 1.0, 1.0)), smoothed.x),
    smoothed.y);
  return mix(lower, upper, smoothed.z);
}

${hasNoiseOctaves ? FRACTAL_NOISE_FUNCTION : ''}fn localFadeProfile(ratio: f32) -> f32 {
  let clamped = clamp(ratio, 0.0, 1.0);
  return 1.0 - clamped * clamped * (3.0 - 2.0 * clamped);
}

fn localWarpedFadePosition(position: f32, noiseAmount: f32, noise: f32) -> f32 {
  let clamped = clamp(position, 0.0, 1.0);
  return clamped + (0.5 - noise) * noiseAmount * LOCAL_VOLUME_EDGE_WARP * 4.0 * clamped * (1.0 - clamped);
}

fn localAxesOffset(volume: i32, offset: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(localVolumeTexel(volume, 5).xyz, offset), dot(localVolumeTexel(volume, 6).xyz, offset), dot(localVolumeTexel(volume, 7).xyz, offset));
}

// The density factor of a volume at a point (localVolumeProfile in local-volumes.js).
fn localVolumeProfile(volume: i32, point: vec3<f32>, withNoise: bool) -> f32 {
${hasGrid ? `  if (localVolumeTexel(volume, 0).w < -0.5) { return localGridSample(volume, point).density; }
` : ''}  let centre = localVolumeTexel(volume, 0);
  let extents = localVolumeTexel(volume, 1);
  let noiseAmount = localVolumeTexel(volume, 2).w;
  let noiseScale = localVolumeTexel(volume, 3).w;
  let offset = localAxesOffset(volume, point - centre.xyz);
  let noisy = withNoise && noiseAmount > 0.0;
  var noise = 0.5;
  if (noisy) { noise = ${hasNoiseOctaves ? 'localVolumeFractalNoise(point * noiseScale, i32(localVolumeTexel(volume, 5).w) + 1)' : 'localVolumeNoise(point * noiseScale)'}; }
  let falloff = extents.w;
  var profile = 1.0;
  if (centre.w > 0.5) {
    let distance = length(offset) / extents.x;
    if (distance >= 1.0) { return 0.0; }
    if (falloff > 0.0) {
      profile = localFadeProfile(localWarpedFadePosition((distance - (1.0 - falloff)) / falloff, select(0.0, noiseAmount, noisy), noise));
    }
  } else {
    let ratio = abs(offset) / extents.xyz;
    if (max(ratio.x, max(ratio.y, ratio.z)) >= 1.0) { return 0.0; }
    if (falloff > 0.0) {
      let core = 1.0 - falloff;
      let fadeDistance = length(max(ratio - vec3<f32>(core), vec3<f32>(0.0)));
      profile = localFadeProfile(localWarpedFadePosition(fadeDistance / falloff, select(0.0, noiseAmount, noisy), noise));
    }
  }
  if (noisy) { profile *= 1.0 + (2.0 * noise - 1.0) * noiseAmount; }
  return profile;
}

// Where the ray is inside the volume, clipped to [0, limit]; the span goes to localSpan (localVolumeInterval in local-volumes.js).
fn localVolumeInterval(volume: i32, origin: vec3<f32>, rayDirection: vec3<f32>, limit: f32) -> bool {
  let centre = localVolumeTexel(volume, 0);
  let extents = localVolumeTexel(volume, 1);
  var entry = 0.0;
  var exitDistance = limit;
  if (centre.w > 0.5) {
    let offset = origin - centre.xyz;
    let along = dot(offset, rayDirection);
    let discriminant = along * along - (dot(offset, offset) - extents.x * extents.x);
    if (discriminant <= 0.0) { return false; }
    let root = sqrt(discriminant);
    entry = max(entry, -along - root);
    exitDistance = min(exitDistance, -along + root);
  } else {
    let relative = -localAxesOffset(volume, origin - centre.xyz);
    let alongDirection = localAxesOffset(volume, rayDirection);
    for (var axis = 0; axis < 3; axis++) {
      if (alongDirection[axis] == 0.0) {
        if (abs(relative[axis]) > extents[axis]) { return false; }
        continue;
      }
      let first = (relative[axis] - extents[axis]) / alongDirection[axis];
      let second = (relative[axis] + extents[axis]) / alongDirection[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
    }
  }
  if (!(entry < exitDistance)) { return false; }
  localSpan = vec2<f32>(entry, exitDistance);
  return true;
}

fn localVolumeStepCount(volume: i32, length: f32) -> f32 {
  let steps = localVolumeTexel(volume, 4).x;
  let noiseAmount = localVolumeTexel(volume, 2).w;
  if (!(noiseAmount > 0.0)) { return steps; }
  let cellSteps = ceil(length * localVolumeTexel(volume, 3).w * LOCAL_VOLUME_STEPS_PER_CELL);
  return min(LOCAL_VOLUME_MAXIMUM_STEPS, max(steps, cellSteps));
}

// The optical depth per channel from a point to the volume's far side along a direction, from midpoint taps of the profile.
fn localOpticalDepth(volume: i32, point: vec3<f32>, rayDirection: vec3<f32>, taps: i32) -> vec3<f32> {
  var exitDistance = 0.0;
  if (localVolumeInterval(volume, point, rayDirection, 1e30)) { exitDistance = max(localSpan.y, 0.0); }
  var profileSum = 0.0;
  for (var tap = 0; tap < taps; tap++) {
    let distance = exitDistance * (f32(tap) + 0.5) / f32(taps);
    profileSum += min(localVolumeProfile(volume, point + rayDirection * distance, false) * LOCAL_VOLUME_DEPTH_SATURATION, 1.0);
  }
  return localVolumeTexel(volume, 2).xyz * profileSum * exitDistance / f32(taps);
}

fn localSkyLight(volume: i32, point: vec3<f32>) -> vec3<f32> {
  var sky = vec3<f32>(0.0);
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(0.0, 1.0, 0.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(1.0, 0.0, 0.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(-1.0, 0.0, 0.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(0.0, 0.0, 1.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(0.0, 0.0, -1.0), 1)) / 5.0;
  return sky * materials[i32(params.seedAndAtlas.w) + 1].xyz * LOCAL_VOLUME_SKY_GAIN;
}

// The light one step of a scattering volume sends back along the ray: scatter * (1 - exp(-extinction * width)) * (sky + sun).
fn localScatteredLight(volume: i32, point: vec3<f32>, width: f32) -> vec3<f32> {
  var lightSum = localSkyLight(volume, point);
  let sunDirection = params.sunDirection.xyz;
  if (params.emittersFlagsSample.y == 1 && !occluded(point, sunDirection, params.environmentRotationAndRays.w)) {
    let flattened = normalize(vec3<f32>(sunDirection.x, sunDirection.y * LOCAL_VOLUME_SUN_FLATTEN, sunDirection.z));
    let sunDepth = localOpticalDepth(volume, point, flattened, 3);
    let phase = henyeyGreensteinPhase(localVolumeTexel(volume, 4).z, dot(sunDirection, direction));
    lightSum += params.sunColorAndCosine.xyz * phase * LOCAL_VOLUME_KEY_GAIN * exp(-sunDepth * LOCAL_VOLUME_SHADOW_STRENGTH);
  }
  let scatter = localVolumeTexel(volume, 4).y;
  let scattered = scatter * (vec3<f32>(1.0) - exp(-localVolumeTexel(volume, 2).xyz * width));
  return scattered * lightSum;
}

// Carries the ray through every local volume it crosses, nearest entry first: adds the light the volumes emit and scatter to the
// path and dims throughput by what they absorb. One random number offsets the samples inside each step.
fn crossLocalVolumes(depth: i32, origin: vec3<f32>, segmentLength: f32) {
  let jitter = nextRandom();
  let count = i32(materials[i32(params.seedAndAtlas.w)].x);
  var entries: array<f32, ${MAX_LOCAL_VOLUMES}>;
  var exits: array<f32, ${MAX_LOCAL_VOLUMES}>;
  var order: array<i32, ${MAX_LOCAL_VOLUMES}>;
  var crossed = 0;
  for (var volume = 0; volume < count; volume++) {
${hasMesh ? `    if (localVolumeTexel(volume, 0).w < -1.5) {
      let segmentCount = meshVolumeSegments(volume, origin, direction, segmentLength);
      if (segmentCount == 0) { continue; }
      localSpan = vec2<f32>(meshSegments[0], meshSegments[segmentCount * 2 - 1]);
    } else if (!localVolumeInterval(volume, origin, direction, segmentLength)) { continue; }
` : `    if (!localVolumeInterval(volume, origin, direction, segmentLength)) { continue; }
`}    entries[volume] = localSpan.x;
    exits[volume] = localSpan.y;
    var slot = crossed;
    crossed++;
    while (slot > 0 && entries[order[slot - 1]] > localSpan.x) {
      order[slot] = order[slot - 1];
      slot--;
    }
    order[slot] = volume;
  }
  var emitted = vec3<f32>(0.0);
  for (var rank = 0; rank < crossed; rank++) {
    let volume = order[rank];
${hasMesh ? `    if (localVolumeTexel(volume, 0).w < -1.5) {
      emitted += crossLocalMesh(volume, origin, segmentLength, jitter);
      continue;
    }
` : ''}${hasGrid ? `    if (localVolumeTexel(volume, 0).w < -0.5) {
      emitted += crossLocalGrid(volume, origin, entries[volume], exits[volume] - entries[volume], jitter);
      continue;
    }
` : ''}    let entry = entries[volume];
    let span = exits[volume] - entry;
    let stepCount = localVolumeStepCount(volume, span);
    let stepLength = span / stepCount;
    let extinction = localVolumeTexel(volume, 2).xyz;
    let emission = localVolumeTexel(volume, 3).xyz;
    let scatters = localVolumeTexel(volume, 4).y > 0.0;
    for (var stepIndex = 0; stepIndex < i32(stepCount); stepIndex++) {
      let point = origin + direction * (entry + (f32(stepIndex) + jitter) * stepLength);
      let profile = localVolumeProfile(volume, point, true);
      if (profile <= 0.0) { continue; }
      let width = profile * stepLength;
      if (scatters) { emitted += throughput * localScatteredLight(volume, point, width); }
      emitted += throughput * emission * width * volumeStepIntegral(extinction * width);
${hasEmissionRamp ? `      emitted += throughput * localEmissionRampLight(volume, vec3<f32>(profile), stepLength) * volumeStepIntegral(extinction * width);
` : ''}      throughput *= exp(-extinction * width);
    }
  }
  addRadiance(depth, emitted);
}
${hasEmissionRamp ? buildRampFunctions(hasGrid) : ''}${hasGrid ? buildGridFunctions({ hasEmissionRamp }) : ''}${hasMesh ? MESH_FUNCTIONS : ''}`;

// The fractal value noise of localVolumeFractalNoise in local-volume-noise.js: octaves at twice the frequency and half the weight, divided by the weights.
const FRACTAL_NOISE_FUNCTION = /* wgsl */ `fn localVolumeFractalNoise(position: vec3<f32>, octaves: i32) -> f32 {
  var sum = 0.0;
  var weight = 1.0;
  var weightSum = 0.0;
  var frequency = 1.0;
  for (var octave = 0; octave < octaves; octave++) {
    sum += weight * localVolumeNoise(position * frequency);
    weightSum += weight;
    weight *= 0.5;
    frequency *= 2.0;
  }
  return sum / weightSum;
}

`;

/**
 * The emission ramp light of one step (addRampLight in the CPU tracer): the baked ramp colour at the source value, times the emission strength, the position
 * along the ramp and the step length. `sources` is (density, temperature, flame); a box or sphere passes its profile in all three. The ramp block is the last
 * block of the buffer, after the grid block, whose size the grid header gives.
 */
const buildRampFunctions = hasGrid => /* wgsl */ `
const LOCAL_RAMP_TEXELS: i32 = ${LOCAL_VOLUME_RAMP_TEXELS};

fn localRampBase() -> i32 {
  let first = i32(params.seedAndAtlas.w);
  var base = first + LOCAL_VOLUME_HEADER_TEXELS + i32(materials[first].x) * LOCAL_VOLUME_TEXELS;
${hasGrid ? `  let resolution = vec3<i32>(materials[base].xyz);
  base += ${LOCAL_VOLUME_GRID_HEADER_TEXELS} + resolution.x * resolution.y * resolution.z * i32(materials[base + 1].w);
` : ''}  return base;
}

fn localEmissionRampLight(volume: i32, sources: vec3<f32>, stepLength: f32) -> vec3<f32> {
  let rampNumber = i32(localVolumeTexel(volume, 7).w);
  if (rampNumber == 0) { return vec3<f32>(0.0); }
  let at = localRampBase() + (rampNumber - 1) * LOCAL_RAMP_TEXELS;
  let header = materials[at];
  let position = clamp((sources[i32(header.x) - 1] - header.z) / (header.w - header.z), 0.0, 1.0);
  if (position <= 0.0) { return vec3<f32>(0.0); }
  let stops = i32(header.y);
  let scaled = position * f32(stops - 1);
  let lower = min(i32(floor(scaled)), stops - 1);
  let upper = min(lower + 1, stops - 1);
  let colour = mix(materials[at + 2 + lower].xyz, materials[at + 2 + upper].xyz, scaled - f32(lower));
  return colour * materials[at + 1].x * position * stepLength;
}
`;

/** The WGSL march and trilinear sampler of a grid volume (crossGridStep and sampleVolumeGrid in the CPU tracer); the block layout is packWebGpuGrid's. */
const buildGridFunctions = ({ hasEmissionRamp }) => /* wgsl */ `
const LOCAL_GRID_HEADER_TEXELS: i32 = ${LOCAL_VOLUME_GRID_HEADER_TEXELS};
const LOCAL_GRID_TIME_STEP: f32 = ${GRID_MOTION_TIME_STEP};

struct GridCell {
  density: f32,
  flame: f32,
  glow: vec3<f32>,${hasEmissionRamp ? `
  temperature: f32,` : ''}
}

struct GridCorner {
  voxel: i32,
  weight: f32,
}

// The vector index of the grid block: it follows the volume table.
fn localGridBase() -> i32 {
  let first = i32(params.seedAndAtlas.w);
  return first + LOCAL_VOLUME_HEADER_TEXELS + i32(materials[first].x) * LOCAL_VOLUME_TEXELS;
}

// The corner's voxel (-1 beyond the grid, which reads 0) and trilinear weight at a point of the unit cube, texel centres at (i + 0.5) / n.
fn localGridCorner(corner: i32, unit: vec3<f32>, resolution: vec3<f32>) -> GridCorner {
  let scaled = unit * resolution - vec3<f32>(0.5);
  let lower = floor(scaled);
  let fraction = scaled - lower;
  let offset = vec3<f32>(f32(corner & 1), f32((corner >> 1) & 1), f32((corner >> 2) & 1));
  let voxel = vec3<i32>(lower + offset);
  let weights = mix(vec3<f32>(1.0) - fraction, fraction, offset);
  let weight = weights.x * weights.y * weights.z;
  let size = vec3<i32>(resolution);
  if (any(voxel < vec3<i32>(0)) || any(voxel >= size) || weight == 0.0) { return GridCorner(-1, 0.0); }
  return GridCorner(voxel.x + size.x * (voxel.y + size.y * voxel.z), weight);
}

fn localGridUnit(volume: i32, point: vec3<f32>) -> vec3<f32> {
  return (point - localVolumeTexel(volume, 0).xyz) / (localVolumeTexel(volume, 1).xyz * 2.0) + vec3<f32>(0.5);
}

fn localGridOutside(unit: vec3<f32>) -> bool {
  return any(unit < vec3<f32>(0.0)) || any(unit > vec3<f32>(1.0));
}

fn localGridSample(volume: i32, point: vec3<f32>) -> GridCell {
  var cell = GridCell(0.0, 0.0, vec3<f32>(0.0)${hasEmissionRamp ? ', 0.0' : ''});
  let unit = localGridUnit(volume, point);
  if (localGridOutside(unit)) { return cell; }
  let base = localGridBase();
  let resolution = materials[base].xyz;
  let stride = i32(materials[base + 1].w);
  let withGlow = materials[base + 1].y > 0.5;
  for (var corner = 0; corner < 8; corner++) {
    let found = localGridCorner(corner, unit, resolution);
    if (found.voxel < 0) { continue; }
    let at = base + LOCAL_GRID_HEADER_TEXELS + found.voxel * stride;
    let values = materials[at];
    cell.density += found.weight * values.x;
    cell.flame += found.weight * values.y;
${hasEmissionRamp ? `    cell.temperature += found.weight * values.z;
` : ''}    if (withGlow) { cell.glow += found.weight * materials[at + 1].xyz; }
  }
  return cell;
}

// The point a motion-blurred step reads instead of its own (localVolumeGridMotionPoint): back along the gas velocity by the step's place in the shutter.
fn localGridMotionPoint(volume: i32, point: vec3<f32>, timeFraction: f32) -> vec3<f32> {
  let base = localGridBase();
  let shutter = materials[base + 1].x;
  if (!(shutter > 0.0)) { return point; }
  let unit = localGridUnit(volume, point);
  if (localGridOutside(unit)) { return point; }
  let resolution = materials[base].xyz;
  let stride = i32(materials[base + 1].w);
  let velocityOffset = select(1, 2, materials[base + 1].y > 0.5);
  var velocity = vec3<f32>(0.0);
  for (var corner = 0; corner < 8; corner++) {
    let found = localGridCorner(corner, unit, resolution);
    if (found.voxel < 0) { continue; }
    velocity += found.weight * materials[base + LOCAL_GRID_HEADER_TEXELS + found.voxel * stride + velocityOffset].xyz;
  }
  return point - velocity * (localVolumeTexel(volume, 1).xyz * 2.0) * (shutter * timeFraction);
}

// One grid volume over its span: extinction from the density, emission from the flame channel and the baked blackbody, one sample per step.
fn crossLocalGrid(volume: i32, origin: vec3<f32>, entry: f32, span: f32, jitter: f32) -> vec3<f32> {
  let stepCount = localVolumeStepCount(volume, span);
  let stepLength = span / stepCount;
  let extinction = localVolumeTexel(volume, 2).xyz;
  let emission = localVolumeTexel(volume, 3).xyz;
  let scatters = localVolumeTexel(volume, 4).y > 0.0;
  let blackbodyWeight = materials[localGridBase()].w;
  var emitted = vec3<f32>(0.0);
  for (var stepIndex = 0; stepIndex < i32(stepCount); stepIndex++) {
    let point = origin + direction * (entry + (f32(stepIndex) + jitter) * stepLength);
    let timeFraction = fract(jitter + f32(stepIndex) * LOCAL_GRID_TIME_STEP);
    let cell = localGridSample(volume, localGridMotionPoint(volume, point, timeFraction));
    let width = cell.density * stepLength;
    if (width > 0.0 && scatters) { emitted += throughput * localScatteredLight(volume, point, width); }
    emitted += throughput * (emission * cell.flame * stepLength + cell.glow * blackbodyWeight * stepLength) * volumeStepIntegral(extinction * width);
${hasEmissionRamp ? `    emitted += throughput * localEmissionRampLight(volume, vec3<f32>(cell.density, cell.temperature, cell.flame), stepLength) * volumeStepIntegral(extinction * width);
` : ''}    throughput *= exp(-extinction * width);
  }
  return emitted;
}
`;

/**
 * The WGSL of a mesh volume (marchMeshVolume and meshVolumeSegments of the CPU tracer): the ray is walked from surface crossing to surface crossing through the mesh's own
 * BVH, the parity of the crossings says where it is inside, and the inside segments share the volume's steps by length. The block layout is packWebGpuMeshVolumes'.
 */
const MESH_FUNCTIONS = /* wgsl */ `
const MESH_MAXIMUM_CROSSINGS: i32 = ${MESH_VOLUME_MAXIMUM_CROSSINGS};
const MESH_MAXIMUM_SEGMENTS: i32 = ${MESH_VOLUME_MAXIMUM_CROSSINGS / 2};
const MESH_TRIANGLE_TEXELS: i32 = ${MESH_VOLUME_TRIANGLE_TEXELS};

var<private> meshCrossings: array<f32, ${MESH_VOLUME_MAXIMUM_CROSSINGS}>;
var<private> meshSegments: array<f32, ${MESH_VOLUME_MAXIMUM_CROSSINGS}>;
var<private> meshNodeStack: array<i32, 128>;
var<private> meshEntryStack: array<f32, 128>;

// The vector index of the mesh block: the second float of the table header says how far it is from the table.
fn meshBlockBase() -> i32 {
  let first = i32(params.seedAndAtlas.w);
  return first + i32(materials[first].y);
}

fn meshBoxEntry(nodeBase: i32, node: i32, origin: vec3<f32>, inverse: vec3<f32>) -> f32 {
  let low = materials[nodeBase + node * 2];
  let high = materials[nodeBase + node * 2 + 1];
  let first = (low.xyz - origin) * inverse;
  let second = (high.xyz - origin) * inverse;
  let nearest = min(first, second);
  let farthest = max(first, second);
  let entry = max(max(max(nearest.x, nearest.y), nearest.z), 0.0);
  let exitDistance = min(min(farthest.x, farthest.y), farthest.z);
  return select(1e30, entry, entry <= exitDistance * (1.0 + 1e-6) + 1e-6);
}

// The distance to the nearest surface of a mesh volume along a ray, either side, or -1 when there is none.
fn meshNearestSurface(nodeBase: i32, triangleBase: i32, origin: vec3<f32>, rayDirection: vec3<f32>) -> f32 {
  var nearest = 1e30;
  let inverse = safeInverse(rayDirection);
  var stackSize = 1;
  meshNodeStack[0] = 0;
  meshEntryStack[0] = 0.0;
  while (stackSize > 0) {
    stackSize--;
    let node = meshNodeStack[stackSize];
    if (!(meshEntryStack[stackSize] < nearest)) { continue; }
    let header = materials[nodeBase + node * 2];
    if (header.w < 0.0) {
      let start = i32(materials[nodeBase + node * 2 + 1].w);
      let end = start + i32(-header.w);
      for (var slot = start; slot < end; slot++) {
        let base = triangleBase + slot * MESH_TRIANGLE_TEXELS;
        let corner = materials[base].xyz;
        let edgeFirst = materials[base + 1].xyz;
        let edgeSecond = materials[base + 2].xyz;
        let pivot = cross(rayDirection, edgeSecond);
        let determinant = dot(edgeFirst, pivot);
        if (determinant == 0.0) { continue; }
        let offset = origin - corner;
        let firstWeight = dot(offset, pivot) / determinant;
        if (firstWeight < 0.0 || firstWeight > 1.0) { continue; }
        let query = cross(offset, edgeFirst);
        let secondWeight = dot(rayDirection, query) / determinant;
        if (secondWeight < 0.0 || firstWeight + secondWeight > 1.0) { continue; }
        let distance = dot(edgeSecond, query) / determinant;
        if (distance < 0.0 || distance >= nearest) { continue; }
        nearest = distance;
      }
      continue;
    }
    let left = node + 1;
    let right = i32(header.w);
    let leftEntry = meshBoxEntry(nodeBase, left, origin, inverse);
    let rightEntry = meshBoxEntry(nodeBase, right, origin, inverse);
    let nearFirst = leftEntry <= rightEntry;
    meshNodeStack[stackSize] = select(left, right, nearFirst);
    meshEntryStack[stackSize] = select(leftEntry, rightEntry, nearFirst);
    meshNodeStack[stackSize + 1] = select(right, left, nearFirst);
    meshEntryStack[stackSize + 1] = select(rightEntry, leftEntry, nearFirst);
    stackSize += 2;
  }
  return select(nearest, -1.0, nearest >= 1e30);
}

// Where a ray is inside a closed mesh volume, clipped to [0, limit]: the [entry, exit] pairs go to meshSegments and their number is returned.
fn meshVolumeSegments(volume: i32, origin: vec3<f32>, rayDirection: vec3<f32>, limit: f32) -> i32 {
  let block = meshBlockBase();
  let descriptor = materials[block + 1 + i32(localVolumeTexel(volume, 4).w)];
  let nodeBase = block + i32(descriptor.x);
  let triangleBase = block + i32(descriptor.y);
  var crossingCount = 0;
  var cursor = 0.0;
  while (crossingCount < MESH_MAXIMUM_CROSSINGS) {
    let distance = meshNearestSurface(nodeBase, triangleBase, origin + rayDirection * cursor, rayDirection);
    if (distance < 0.0) { break; }
    cursor += distance;
    meshCrossings[crossingCount] = cursor;
    crossingCount++;
    cursor += descriptor.z;
  }
  var inside = (crossingCount % 2) == 1;
  var start = 0.0;
  var segmentCount = 0;
  for (var crossing = 0; crossing < crossingCount; crossing++) {
    let distance = meshCrossings[crossing];
    if (inside) {
      let end = min(distance, limit);
      if (end > start && segmentCount < MESH_MAXIMUM_SEGMENTS) {
        meshSegments[segmentCount * 2] = start;
        meshSegments[segmentCount * 2 + 1] = end;
        segmentCount++;
      }
    } else {
      start = distance;
    }
    inside = !inside;
  }
  return segmentCount;
}

// One mesh volume along the ray: its steps are shared between the inside segments in proportion to their length, and the profile is 1.
fn crossLocalMesh(volume: i32, origin: vec3<f32>, limit: f32, jitter: f32) -> vec3<f32> {
  let segmentCount = meshVolumeSegments(volume, origin, direction, limit);
  var total = 0.0;
  for (var segment = 0; segment < segmentCount; segment++) { total += meshSegments[segment * 2 + 1] - meshSegments[segment * 2]; }
  let extinction = localVolumeTexel(volume, 2).xyz;
  let emission = localVolumeTexel(volume, 3).xyz;
  let volumeSteps = localVolumeTexel(volume, 4).x;
  var emitted = vec3<f32>(0.0);
  for (var segment = 0; segment < segmentCount; segment++) {
    let entry = meshSegments[segment * 2];
    let segmentLength = meshSegments[segment * 2 + 1] - entry;
    let steps = max(1, i32(floor(volumeSteps * segmentLength / total + 0.5)));
    let stepLength = segmentLength / f32(steps);
    for (var stepIndex = 0; stepIndex < steps; stepIndex++) {
      emitted += throughput * emission * stepLength * volumeStepIntegral(extinction * stepLength);
      throughput *= exp(-extinction * stepLength);
    }
  }
  return emitted;
}
`;

/** The march without grids, as the kernel splices it into a scene that has box and sphere volumes. */
export const LOCAL_VOLUME_FUNCTIONS = buildLocalVolumeFunctions();
