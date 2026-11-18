import { MAX_POINT_LIGHTS } from './light-limits.js';
import { volumeGridFloats, gridTemperature, blackbodyRadiance } from './volume-grid.js';

// Fire is light (#1046). A local volume with `lightsScene: true` adds one point light at the centre of its emission, so the ground, the
// props and the smoke around a fireball are lit by it. The light's intensity is the emission integrated over the volume: a medium that
// emits `j` radiance per metre has a total power of 4 pi j V, which a point light of intensity j V (per steradian) reproduces.
// This holds for the rasterizer; the CPU path tracer already finds the emission by tracing through the volume.

const FIRE_LIGHT_MINIMUM_INTENSITY = 1e-6;
const FIRE_LIGHT_RADIUS_SHARE = 0.5;

/** A fire light is as large as a ball that holds half the volume's width, so the highlight on a close surface is soft instead of a pinpoint. */
function lightRadiusOf(size) {
  return Math.max(0.05, FIRE_LIGHT_RADIUS_SHARE * Math.cbrt(size[0] * size[1] * size[2]) / 2);
}

function constantEmissionTotals(volume) {
  const volumeSize = volume.shape === 'sphere' ? [volume.radius * 2, volume.radius * 2, volume.radius * 2] : volume.size;
  const cubicMetres = volume.shape === 'sphere' ? (4 / 3) * Math.PI * volume.radius ** 3 : volumeSize[0] * volumeSize[1] * volumeSize[2];
  const total = volume.emission.map(channel => channel * volume.emissionStrength * cubicMetres);
  return { total, centroid: volume.center.slice(), size: volumeSize };
}

const totalsByGrid = new WeakMap();

// The summed emission of one grid frame in grid cell units and its luminance-weighted centroid in the unit cube. Decoded once per frame of the sequence.
function gridEmissionSums(gridData, volume) {
  const key = `${volume.emission}|${volume.emissionStrength}|${volume.temperatureScale}|${volume.blackbodyIntensity}|${volume.flameTemperature?.ignition}|${volume.flameTemperature?.maximum}`;
  const cached = totalsByGrid.get(gridData);
  if (cached?.key === key) return cached;
  const floats = volumeGridFloats(gridData);
  const [width, height, depth] = gridData.resolution;
  const flame = floats.flame ?? floats.density;
  const temperature = gridTemperature(gridData, volume.flameTemperature) ?? null;
  const total = [0, 0, 0];
  const centroidWeight = [0, 0, 0];
  const blackbody = [0, 0, 0];
  const emitted = [0, 0, 0];
  const glows = volume.blackbodyIntensity > 0 && temperature;
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = x + y * width + z * width * height;
        const flameValue = flame ? flame[cell] : 0;
        if (flameValue === 0 && !glows) continue; // an empty cell emits nothing; a sequence runs this over every frame, so it stays free of allocations
        for (let channel = 0; channel < 3; channel++) emitted[channel] = volume.emission[channel] * volume.emissionStrength * flameValue;
        if (glows) {
          blackbodyRadiance(temperature[cell] * volume.temperatureScale, blackbody);
          for (let channel = 0; channel < 3; channel++) emitted[channel] += blackbody[channel] * volume.blackbodyIntensity * volume.emissionStrength;
        }
        const luminance = emitted[0] + emitted[1] + emitted[2];
        if (!(luminance > 0)) continue;
        for (let channel = 0; channel < 3; channel++) total[channel] += emitted[channel];
        centroidWeight[0] += luminance * (x + 0.5) / width;
        centroidWeight[1] += luminance * (y + 0.5) / height;
        centroidWeight[2] += luminance * (z + 0.5) / depth;
      }
    }
  }
  const luminanceSum = total[0] + total[1] + total[2];
  const sums = { key, total, unitCentroid: luminanceSum > 0 ? centroidWeight.map(weight => weight / luminanceSum) : [0.5, 0.5, 0.5] };
  totalsByGrid.set(gridData, sums);
  return sums;
}

function gridEmissionTotals(volume) {
  const sums = gridEmissionSums(volume.gridData, volume);
  const [width, height, depth] = volume.gridData.resolution;
  const cubicMetres = volume.size[0] * volume.size[1] * volume.size[2];
  const cellShare = cubicMetres / (width * height * depth);
  const centroid = volume.center.map((center, axis) => center + (sums.unitCentroid[axis] - 0.5) * volume.size[axis]);
  return { total: sums.total.map(channel => channel * cellShare), centroid, size: volume.size };
}

/**
 * The point lights for the volumes that asked for them. Pass volumes already bound by bindLocalVolumeParts (grids carry `gridData`).
 * A mesh volume has no box of its own here and gives no light. Returns at most `room` lights.
 */
export function fireLightsOf(volumes, room = MAX_POINT_LIGHTS) {
  const lights = [];
  for (const volume of volumes) {
    if (!volume.lightsScene || lights.length >= room) continue;
    if (volume.shape === 'mesh') continue;
    const { total, centroid, size } = volume.shape === 'grid' ? gridEmissionTotals(volume) : constantEmissionTotals(volume);
    const peak = Math.max(total[0], total[1], total[2]);
    if (!(peak > FIRE_LIGHT_MINIMUM_INTENSITY)) continue;
    lights.push({ position: centroid, color: total.map(channel => channel / peak), intensity: peak, radius: lightRadiusOf(size), range: 0 });
  }
  return lights;
}
