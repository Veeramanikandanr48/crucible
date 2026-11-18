// A smoke and fire solver on a uniform grid, baked into the grid volume format (#1735, volume-grid.js). Written from the papers:
// Stam 1999 "Stable Fluids" (semi-Lagrangian advection, pressure projection), Fedkiw, Stam and Jensen 2001 "Visual Simulation of Smoke"
// (buoyancy, vorticity confinement), Selle et al. 2008 "An Unconditionally Stable MacCormack Method" (with its limiter) and a simple
// fuel -> flame, heat and smoke burn in the spirit of Mantaflow's fire model. No runtime dependency, no Math.random: the same options give
// the same bytes.
//
// Layout: index = x + nx * (y + ny * z), x fastest, y up, the floor is the plane y = 0 (solid); the sides and the top are open.
// Cells are cubes of `cellSize` metres. Velocity is in metres per second, density is smoke, fuel and flame are 0 to 1 per cell.

import { encodeVolumeGrid, registerVolumeGrid } from './volume-grid.js';
import { VOLUME_GRID_SEQUENCE_MAX_BYTES } from './volume-grid-sequence.js';

/**
 * Kelvin per unit of the `temperature` channel the bake writes. Pass it as `temperatureScale` on the grid volume. The channel holds the kelvin above
 * the ambient air, so cold air reads 0 and the blackbody adds no glow where there is no heat.
 */
export const GAS_SIM_TEMPERATURE_UNIT = 1000;
export const GAS_SIM_MIN_AXIS = 8;
export const GAS_SIM_MAX_AXIS = 96;
export const GAS_SIM_MAX_FRAMES = 240;

const MAXIMUM_TEMPERATURE = 5000;
const ADVECTION_MODES = ['maccormack', 'semi-lagrangian'];

// Every numeric option: [fallback, minimum, maximum, integer]. The unit is in the comment.
const NUMBER_OPTIONS = {
  frames: [72, 1, GAS_SIM_MAX_FRAMES, true], // 3 s at 24 fps
  fps: [24, 1, 120, false],
  substeps: [2, 1, 8, true], // solver steps per frame
  seed: [1, 0, 4294967295, true],
  maxSeconds: [120, 0.1, 3600, false], // wall-clock budget of the whole bake
  cellSize: [0.125, 0.005, 2, false], // metres
  pressureIterations: [20, 4, 100, true],
  vorticity: [8, 0, 40, false], // confinement strength
  temperatureLift: [14, 0, 100, false], // m/s^2 per 1000 K above ambient
  densityWeight: [0.4, 0, 20, false], // m/s^2 per unit of smoke density
  ambientTemperature: [300, 100, 1000, false], // K
  cooling: [1.4, 0, 20, false], // 1/s toward ambient
  dissipation: [0.05, 0, 20, false], // 1/s smoke fade
  flameDecay: [5, 0, 50, false], // 1/s
  burnRate: [10, 0.01, 200, false], // 1/s fuel burn at a hot cell
  ignitionTemperature: [500, 300, 3000, false], // K
  heatRelease: [1600, 0, 4000, false], // K gained per unit of fuel burned
  smokeYield: [0.5, 0, 10, false], // smoke density per unit of fuel burned
  burstRadius: [0.9, 0.05, 20, false], // metres
  burstFuel: [1, 0, 10, false], // fuel at the core
  burstSmoke: [0.8, 0, 10, false], // smoke density at the core
  burstTemperature: [2400, 300, MAXIMUM_TEMPERATURE, false], // K
  burstSpeed: [6, 0, 100, false], // m/s outward at the core
  burstSeconds: [0.2, 0.001, 5, false], // how long the source feeds in
  turbulence: [0.35, 0, 1, false], // how far noise pushes the burst's shape and clumps
  detail: [0, 0, 1, false] // noise upres of the smoke density in each baked frame, 1 mottles it by about half (0 leaves the bake as it was)
};

function checkNumber(name, value, [fallback, minimum, maximum, integer]) {
  const given = value === undefined ? fallback : value;
  if (typeof given !== 'number' || !Number.isFinite(given) || given < minimum || given > maximum || (integer && !Number.isInteger(given))) {
    throw new RangeError(`bakeGasSim: ${name} must be ${integer ? 'an integer' : 'a number'} from ${minimum} to ${maximum}, got ${typeof given === 'number' ? given : typeof given}; pass a value in that range or leave it out for ${fallback}`);
  }
  return given;
}

function checkResolution(value) {
  const given = value === undefined ? 64 : value;
  const axes = typeof given === 'number' ? [given, given, given] : given;
  if (!Array.isArray(axes) || axes.length !== 3) {
    throw new TypeError(`bakeGasSim: resolution must be one integer or [x, y, z] of integers from ${GAS_SIM_MIN_AXIS} to ${GAS_SIM_MAX_AXIS}, got ${JSON.stringify(given)}`);
  }
  for (const axis of axes) {
    if (!Number.isInteger(axis) || axis < GAS_SIM_MIN_AXIS || axis > GAS_SIM_MAX_AXIS) {
      throw new RangeError(`bakeGasSim: resolution ${JSON.stringify(given)} is out of range: each axis must be an integer from ${GAS_SIM_MIN_AXIS} to ${GAS_SIM_MAX_AXIS}; pass 64 for a 64 cubed grid`);
    }
  }
  return axes.slice();
}

function checkPosition(value, resolution, cellSize) {
  if (value === undefined) return [resolution[0] * cellSize / 2, 0, resolution[2] * cellSize / 2];
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new TypeError(`bakeGasSim: burstPosition must be [x, y, z] in metres from the grid's corner (floor at y 0), got ${JSON.stringify(value)}; leave it out for the middle of the floor`);
  }
  const size = resolution.map(axis => axis * cellSize);
  value.forEach((coordinate, axis) => {
    if (coordinate < 0 || coordinate > size[axis]) {
      throw new RangeError(`bakeGasSim: burstPosition[${axis}] must be from 0 to ${size[axis]} (the grid's box), got ${coordinate}`);
    }
  });
  return value.slice();
}

/** Checks every option and fills the defaults. Throws an error that names the field and its range. */
export function resolveGasSimOptions(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('bakeGasSim: options must be an object, or leave it out for a 3 s ground blast');
  const resolved = {};
  for (const [name, spec] of Object.entries(NUMBER_OPTIONS)) resolved[name] = checkNumber(name, options[name], spec);
  const advection = options.advection ?? ADVECTION_MODES[0];
  if (!ADVECTION_MODES.includes(advection)) throw new RangeError(`bakeGasSim: advection must be one of ${ADVECTION_MODES.join(', ')}, got ${JSON.stringify(advection)}`);
  resolved.advection = advection;
  if (options.velocity !== undefined && typeof options.velocity !== 'boolean') throw new TypeError(`bakeGasSim: velocity must be true or false, got ${JSON.stringify(options.velocity)}; pass true to bake the gas velocity for motion blur or leave it out`);
  resolved.velocity = options.velocity === true;
  resolved.resolution = checkResolution(options.resolution);
  resolved.burstPosition = checkPosition(options.burstPosition, resolved.resolution, resolved.cellSize);
  resolved.size = resolved.resolution.map(axis => axis * resolved.cellSize);
  return resolved;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// A hash of a lattice point to 0..1, so a seed fixes the burst's shape without any shared random state.
function latticeValue(seed, x, y, z) {
  let hash = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1)) | 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(seed, x, y, z) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smoothstep(0, 1, x - x0);
  const fy = smoothstep(0, 1, y - y0);
  const fz = smoothstep(0, 1, z - z0);
  const corner = (dx, dy, dz) => latticeValue(seed, x0 + dx, y0 + dy, z0 + dz);
  const lowY = (1 - fx) * ((1 - fz) * corner(0, 0, 0) + fz * corner(0, 0, 1)) + fx * ((1 - fz) * corner(1, 0, 0) + fz * corner(1, 0, 1));
  const highY = (1 - fx) * ((1 - fz) * corner(0, 1, 0) + fz * corner(0, 1, 1)) + fx * ((1 - fz) * corner(1, 1, 0) + fz * corner(1, 1, 1));
  return (1 - fy) * lowY + fy * highY;
}

// Noise upres of a baked density (#1735): multiplies each smoke cell by 1 + 4 * detail * noise, two octaves about 5 and 2.5 cells wide that rise with the
// frame, so thin smoke breaks into puffs and gaps below the grid's resolution. Empty cells stay empty. The solver never reads the result back.
function addSmokeDetail(smoke, options, frameIndex) {
  const [nx, ny, nz] = options.resolution;
  const rise = frameIndex * 0.15;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const index = x + nx * (y + ny * z);
        if (smoke[index] === 0) continue;
        const large = valueNoise(options.seed + 101, x / 5, (y - rise) / 5, z / 5);
        const small = valueNoise(options.seed + 102, x / 2.5, (y - rise) / 2.5, z / 2.5);
        smoke[index] *= Math.max(1 + 4 * options.detail * ((large + 0.5 * small) / 1.5 - 0.5), 0);
      }
    }
  }
}

function createSolver(options) {
  const [nx, ny, nz] = options.resolution;
  const nxy = nx * ny;
  const count = nxy * nz;
  const cell = options.cellSize;
  const maxX = nx - 1;
  const maxY = ny - 1;
  const maxZ = nz - 1;
  const field = () => new Float32Array(count);
  const velocityX = field();
  const velocityY = field();
  const velocityZ = field();
  const density = field();
  const temperature = field().fill(options.ambientTemperature);
  const fuel = field();
  const flame = field();
  const scratch = field();
  const second = field();
  const pressure = field();
  const divergence = field();
  const vorticityX = field();
  const vorticityY = field();
  const vorticityZ = field();
  const vorticityLength = field();
  const backX = field();
  const backY = field();
  const backZ = field();
  const forwardX = field();
  const forwardY = field();
  const forwardZ = field();
  const useMacCormack = options.advection === 'maccormack';
  let cornerMinimum = 0;
  let cornerMaximum = 0;

  // Finds the cell and the fractions of a position in cell units (cell i has its centre at i), clamped to the box. interpolate and readCornerRange read what it leaves behind.
  let cellBase = 0;
  let fractionX = 0;
  let fractionY = 0;
  let fractionZ = 0;
  function locate(positionX, positionY, positionZ) {
    const x = positionX < 0 ? 0 : positionX > maxX ? maxX : positionX;
    const y = positionY < 0 ? 0 : positionY > maxY ? maxY : positionY;
    const z = positionZ < 0 ? 0 : positionZ > maxZ ? maxZ : positionZ;
    const x0 = x >= maxX ? maxX - 1 : Math.floor(x);
    const y0 = y >= maxY ? maxY - 1 : Math.floor(y);
    const z0 = z >= maxZ ? maxZ - 1 : Math.floor(z);
    fractionX = x - x0;
    fractionY = y - y0;
    fractionZ = z - z0;
    cellBase = x0 + nx * y0 + nxy * z0;
  }

  // The located cell and fractions of every cell's traced position, kept so the seven advections of one step locate each position once.
  const backLocation = { base: new Int32Array(count), x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count) };
  const forwardLocation = { base: new Int32Array(count), x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count) };

  function storeLocations(location, positionsX, positionsY, positionsZ) {
    for (let index = 0; index < count; index++) {
      locate(positionsX[index], positionsY[index], positionsZ[index]);
      location.base[index] = cellBase;
      location.x[index] = fractionX;
      location.y[index] = fractionY;
      location.z[index] = fractionZ;
    }
  }

  // Trilinear value of `values` at a stored location of one cell.
  function interpolateStored(values, location, index) {
    cellBase = location.base[index];
    fractionX = location.x[index];
    fractionY = location.y[index];
    fractionZ = location.z[index];
    return interpolate(values);
  }

  // Trilinear value of the field at the located position.
  function interpolate(values) {
    const base = cellBase;
    const c000 = values[base];
    const c100 = values[base + 1];
    const c010 = values[base + nx];
    const c110 = values[base + nx + 1];
    const c001 = values[base + nxy];
    const c101 = values[base + nxy + 1];
    const c011 = values[base + nxy + nx];
    const c111 = values[base + nxy + nx + 1];
    const low = (c000 + (c100 - c000) * fractionX) + ((c010 + (c110 - c010) * fractionX) - (c000 + (c100 - c000) * fractionX)) * fractionY;
    const high = (c001 + (c101 - c001) * fractionX) + ((c011 + (c111 - c011) * fractionX) - (c001 + (c101 - c001) * fractionX)) * fractionY;
    return low + (high - low) * fractionZ;
  }

  // Leaves the range of the eight corners of the located position in cornerMinimum and cornerMaximum.
  function readCornerRange(values) {
    const base = cellBase;
    const c000 = values[base];
    const c100 = values[base + 1];
    const c010 = values[base + nx];
    const c110 = values[base + nx + 1];
    const c001 = values[base + nxy];
    const c101 = values[base + nxy + 1];
    const c011 = values[base + nxy + nx];
    const c111 = values[base + nxy + nx + 1];
    cornerMinimum = Math.min(c000, c100, c010, c110, c001, c101, c011, c111);
    cornerMaximum = Math.max(c000, c100, c010, c110, c001, c101, c011, c111);
  }

  // Where each cell's content came from (back, midpoint rule) and where it goes (forward), in cell units.
  function traceVelocity(dt, tracesForward) {
    const stepInCells = dt / cell;
    let index = 0;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, index++) {
          const u = velocityX[index];
          const v = velocityY[index];
          const w = velocityZ[index];
          const midX = x - 0.5 * stepInCells * u;
          const midY = y - 0.5 * stepInCells * v;
          const midZ = z - 0.5 * stepInCells * w;
          locate(midX, midY, midZ);
          backX[index] = x - stepInCells * interpolate(velocityX);
          backY[index] = y - stepInCells * interpolate(velocityY);
          backZ[index] = z - stepInCells * interpolate(velocityZ);
          forwardX[index] = x + stepInCells * u;
          forwardY[index] = y + stepInCells * v;
          forwardZ[index] = z + stepInCells * w;
        }
      }
    }
    storeLocations(backLocation, backX, backY, backZ);
    if (tracesForward) storeLocations(forwardLocation, forwardX, forwardY, forwardZ);
  }

  // Semi-Lagrangian, or MacCormack with the corner-range limiter: forward and backward passes estimate the error and add half of it back.
  function advect(values, limited) {
    for (let index = 0; index < count; index++) scratch[index] = interpolateStored(values, backLocation, index);
    if (!limited) {
      values.set(scratch);
      return;
    }
    for (let index = 0; index < count; index++) {
      const returned = interpolateStored(scratch, forwardLocation, index);
      cellBase = backLocation.base[index];
      readCornerRange(values);
      const corrected = scratch[index] + 0.5 * (values[index] - returned);
      second[index] = corrected < cornerMinimum ? cornerMinimum : corrected > cornerMaximum ? cornerMaximum : corrected;
    }
    values.set(second);
  }

  // The share of a cell's content that this step carries out of the box: how far its moved cell reaches past the outer face (0 to 1 per axis).
  // The sides and the top are open; the floor is a wall, so nothing leaves there.
  function leavingShare(index) {
    const outX = Math.min(Math.max(forwardX[index] - maxX, 0) + Math.max(-forwardX[index], 0), 1);
    const outY = Math.min(Math.max(forwardY[index] - maxY, 0), 1);
    const outZ = Math.min(Math.max(forwardZ[index] - maxZ, 0) + Math.max(-forwardZ[index], 0), 1);
    return 1 - (1 - outX) * (1 - outY) * (1 - outZ);
  }

  // Advects a quantity that is mass (smoke, fuel). Advection only moves it around, so the total after the step must equal the total before,
  // less what leaves through the open sides and top. The limiter and the interpolation do not keep that, so the result is scaled back to it.
  function advectConserved(values) {
    let before = 0;
    let leaving = 0;
    for (let index = 0; index < count; index++) {
      before += values[index];
      leaving += values[index] * leavingShare(index);
    }
    advect(values, useMacCormack);
    let after = 0;
    for (let index = 0; index < count; index++) after += values[index];
    const wanted = before - leaving;
    if (after <= 1e-12 || wanted <= 0) return;
    const scale = wanted / after;
    for (let index = 0; index < count; index++) values[index] *= scale;
  }

  // The burst: a noisy sphere on the floor that feeds fuel, smoke, heat and outward speed for `burstSeconds`.
  function applyBurst(dt, time) {
    if (time >= options.burstSeconds) return;
    const feed = dt / options.burstSeconds;
    const [centerX, centerY, centerZ] = options.burstPosition;
    const radius = options.burstRadius;
    const lattice = radius * 0.7;
    const noiseSeed = options.seed | 0;
    const reach = Math.ceil(radius * 1.8 / cell);
    const cx = Math.round(centerX / cell - 0.5);
    const cy = Math.round(centerY / cell - 0.5);
    const cz = Math.round(centerZ / cell - 0.5);
    for (let z = Math.max(cz - reach, 0); z <= Math.min(cz + reach, maxZ); z++) {
      for (let y = Math.max(cy - reach, 0); y <= Math.min(cy + reach, maxY); y++) {
        for (let x = Math.max(cx - reach, 0); x <= Math.min(cx + reach, maxX); x++) {
          const offsetX = (x + 0.5) * cell - centerX;
          const offsetY = (y + 0.5) * cell - centerY;
          const offsetZ = (z + 0.5) * cell - centerZ;
          const distance = Math.hypot(offsetX, offsetY, offsetZ);
          const shape = valueNoise(noiseSeed, offsetX / lattice + 31.7, offsetY / lattice + 11.3, offsetZ / lattice + 57.1)
            + 0.5 * valueNoise(noiseSeed + 1, offsetX / (lattice * 0.45) + 7.9, offsetY / (lattice * 0.45) + 3.1, offsetZ / (lattice * 0.45) + 19.3);
          const scaledRadius = radius * (1 + options.turbulence * (shape / 0.75 - 1));
          const weight = 1 - smoothstep(0.55, 1, distance / scaledRadius);
          if (weight <= 0) continue;
          const index = x + nx * y + nxy * z;
          const inverseDistance = distance > 1e-6 ? 1 / distance : 0;
          const speed = options.burstSpeed * weight;
          fuel[index] = Math.min(fuel[index] + weight * options.burstFuel * feed, 1);
          density[index] += weight * options.burstSmoke * feed;
          temperature[index] = Math.max(temperature[index], options.ambientTemperature + weight * (options.burstTemperature - options.ambientTemperature));
          velocityX[index] += (offsetX * inverseDistance * speed - velocityX[index]) * weight;
          velocityY[index] += (offsetY * inverseDistance * speed - velocityY[index]) * weight;
          velocityZ[index] += (offsetZ * inverseDistance * speed - velocityZ[index]) * weight;
        }
      }
    }
  }

  function applyBuoyancy(dt) {
    const lift = options.temperatureLift / GAS_SIM_TEMPERATURE_UNIT;
    for (let index = 0; index < count; index++) {
      velocityY[index] += dt * (lift * (temperature[index] - options.ambientTemperature) - options.densityWeight * density[index]);
    }
  }

  // Fedkiw 2001: push velocity along N x omega, N the direction of rising vorticity magnitude, so small eddies are not smoothed away.
  function applyVorticityConfinement(dt) {
    if (options.vorticity === 0) return;
    const half = 0.5 / cell;
    for (let z = 1; z < maxZ; z++) {
      for (let y = 1; y < maxY; y++) {
        for (let x = 1; x < maxX; x++) {
          const index = x + nx * y + nxy * z;
          const wx = (velocityZ[index + nx] - velocityZ[index - nx] - velocityY[index + nxy] + velocityY[index - nxy]) * half;
          const wy = (velocityX[index + nxy] - velocityX[index - nxy] - velocityZ[index + 1] + velocityZ[index - 1]) * half;
          const wz = (velocityY[index + 1] - velocityY[index - 1] - velocityX[index + nx] + velocityX[index - nx]) * half;
          vorticityX[index] = wx;
          vorticityY[index] = wy;
          vorticityZ[index] = wz;
          vorticityLength[index] = Math.hypot(wx, wy, wz);
        }
      }
    }
    const strength = options.vorticity * cell * dt;
    for (let z = 2; z < maxZ - 1; z++) {
      for (let y = 2; y < maxY - 1; y++) {
        for (let x = 2; x < maxX - 1; x++) {
          const index = x + nx * y + nxy * z;
          const gradientX = (vorticityLength[index + 1] - vorticityLength[index - 1]) * half;
          const gradientY = (vorticityLength[index + nx] - vorticityLength[index - nx]) * half;
          const gradientZ = (vorticityLength[index + nxy] - vorticityLength[index - nxy]) * half;
          const inverseLength = 1 / (Math.hypot(gradientX, gradientY, gradientZ) + 1e-6);
          const normalX = gradientX * inverseLength;
          const normalY = gradientY * inverseLength;
          const normalZ = gradientZ * inverseLength;
          velocityX[index] += strength * (normalY * vorticityZ[index] - normalZ * vorticityY[index]);
          velocityY[index] += strength * (normalZ * vorticityX[index] - normalX * vorticityZ[index]);
          velocityZ[index] += strength * (normalX * vorticityY[index] - normalY * vorticityX[index]);
        }
      }
    }
  }

  // Stam 1999 projection: solve the Poisson equation with red-black Gauss-Seidel for a fixed count, then subtract the pressure gradient.
  // The floor is a wall (zero normal gradient, no flow through it); the sides and the top are open (pressure 0 outside).
  function project() {
    const half = 0.5 / cell;
    const cellSquared = cell * cell;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const index = x + nx * y + nxy * z;
          const right = x < maxX ? index + 1 : index;
          const left = x > 0 ? index - 1 : index;
          const up = y < maxY ? index + nx : index;
          const front = z < maxZ ? index + nxy : index;
          const back = z > 0 ? index - nxy : index;
          const belowVelocity = y > 0 ? velocityY[index - nx] : -velocityY[index];
          divergence[index] = ((velocityX[right] - velocityX[left]) + (velocityY[up] - belowVelocity) + (velocityZ[front] - velocityZ[back])) * half;
        }
      }
    }
    for (let iteration = 0; iteration < options.pressureIterations * 2; iteration++) {
      const color = iteration & 1;
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = (color + y + z) & 1; x < nx; x += 2) {
            const index = x + nx * y + nxy * z;
            const sum = (x < maxX ? pressure[index + 1] : 0) + (x > 0 ? pressure[index - 1] : 0)
              + (y < maxY ? pressure[index + nx] : 0) + (y > 0 ? pressure[index - nx] : pressure[index])
              + (z < maxZ ? pressure[index + nxy] : 0) + (z > 0 ? pressure[index - nxy] : 0);
            pressure[index] = (sum - divergence[index] * cellSquared) / 6;
          }
        }
      }
    }
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const index = x + nx * y + nxy * z;
          const rightPressure = x < maxX ? pressure[index + 1] : 0;
          const leftPressure = x > 0 ? pressure[index - 1] : 0;
          const upPressure = y < maxY ? pressure[index + nx] : 0;
          const belowPressure = y > 0 ? pressure[index - nx] : pressure[index];
          const frontPressure = z < maxZ ? pressure[index + nxy] : 0;
          const backPressure = z > 0 ? pressure[index - nxy] : 0;
          velocityX[index] -= (rightPressure - leftPressure) * half;
          velocityY[index] -= (upPressure - belowPressure) * half;
          velocityZ[index] -= (frontPressure - backPressure) * half;
        }
      }
    }
    for (let index = 0; index < nxy; index++) velocityY[index] = Math.max(velocityY[index], 0);
  }

  // Fuel burns where it is hot enough: it becomes flame, heat and smoke. Flame fades, heat cools toward ambient, smoke dissipates.
  function applyCombustion(dt) {
    const burnFraction = 1 - Math.exp(-options.burnRate * dt);
    const flameKeep = Math.exp(-options.flameDecay * dt);
    const coolKeep = Math.exp(-options.cooling * dt);
    const smokeKeep = Math.exp(-options.dissipation * dt);
    for (let index = 0; index < count; index++) {
      let heat = temperature[index];
      if (fuel[index] > 1e-5 && heat > options.ignitionTemperature) {
        const burned = fuel[index] * burnFraction;
        fuel[index] -= burned;
        flame[index] = flame[index] * flameKeep + burned;
        heat += burned * options.heatRelease;
        density[index] += burned * options.smokeYield;
      } else {
        flame[index] *= flameKeep;
      }
      heat = options.ambientTemperature + (heat - options.ambientTemperature) * coolKeep;
      temperature[index] = heat > MAXIMUM_TEMPERATURE ? MAXIMUM_TEMPERATURE : heat;
      density[index] *= smokeKeep;
    }
  }

  function step(dt, time) {
    applyBurst(dt, time);
    applyBuoyancy(dt);
    applyVorticityConfinement(dt);
    traceVelocity(dt, false);
    advect(velocityX, false);
    advect(velocityY, false);
    advect(velocityZ, false);
    project();
    traceVelocity(dt, useMacCormack);
    advectConserved(density);
    advectConserved(fuel);
    advect(temperature, useMacCormack);
    advect(flame, useMacCormack);
    applyCombustion(dt);
  }

  function snapshot(frameIndex) {
    const kelvinPerUnit = 1 / GAS_SIM_TEMPERATURE_UNIT;
    const excess = temperature.map(kelvin => (kelvin - options.ambientTemperature) * kelvinPerUnit);
    const channels = { density: density.slice(), temperature: excess, flame: flame.slice() };
    if (options.detail > 0) addSmokeDetail(channels.density, options, frameIndex);
    // The velocity channels are written only on request (#1759), so a bake without them is byte for byte what it was.
    if (options.velocity) Object.assign(channels, { velocityX: velocityX.slice(), velocityY: velocityY.slice(), velocityZ: velocityZ.slice() });
    return channels;
  }

  return { step, snapshot };
}

// Runs the solver and calls `onFrame(frame, index)` with each frame's channels. Frame 0 is the state at t = 0 after the first burst feed.
function runGasSim(options, onFrame) {
  const started = performance.now();
  const solver = createSolver(options);
  const stepSeconds = 1 / (options.fps * options.substeps);
  let time = 0;
  for (let frame = 0; frame < options.frames; frame++) {
    for (let substep = 0; substep < options.substeps; substep++) {
      solver.step(stepSeconds, time);
      time += stepSeconds;
    }
    const elapsed = (performance.now() - started) / 1000;
    if (elapsed > options.maxSeconds) {
      throw new RangeError(`bakeGasSim: maxSeconds ${options.maxSeconds} passed after ${elapsed.toFixed(1)} s at frame ${frame + 1} of ${options.frames}; lower resolution, frames or substeps, or raise maxSeconds`);
    }
    onFrame(solver.snapshot(frame), frame);
  }
}

/**
 * Bakes a ground blast. Returns `{ frames: [{ density, temperature, flame }], resolution, size, fps }`, Float32Arrays, temperature in GAS_SIM_TEMPERATURE_UNIT kelvin above ambient.
 * With `velocity: true` each frame also holds `velocityX`, `velocityY` and `velocityZ` in metres per second, which a grid volume blurs along when the scene's motion blur shutter is on.
 */
export function bakeGasSim(options = {}) {
  const resolved = resolveGasSimOptions(options);
  const frames = [];
  runGasSim(resolved, frame => frames.push(frame));
  return { frames, resolution: resolved.resolution, size: resolved.size, fps: resolved.fps };
}

/**
 * Bakes a blast and registers each frame as a grid named `<namePrefix>_0000.67vg`, `_0001`, ... Returns the list of names: pass it as `frames` of a
 * local volume `{ shape: 'grid', frames, fps }` (fps is the option you baked with) with `temperatureScale: GAS_SIM_TEMPERATURE_UNIT`. `velocity: true` adds the velocity channels (see bakeGasSim).
 */
export function bakeGasSimToGrids(options = {}, namePrefix = 'gas') {
  if (typeof namePrefix !== 'string' || namePrefix === '') throw new TypeError('bakeGasSimToGrids: namePrefix must be a non-empty string, such as "blast"');
  const resolved = resolveGasSimOptions(options);
  const frameBytes = resolved.resolution[0] * resolved.resolution[1] * resolved.resolution[2] * 2 * (resolved.velocity ? 6 : 3);
  if (frameBytes * resolved.frames > VOLUME_GRID_SEQUENCE_MAX_BYTES) {
    const fitting = Math.floor(VOLUME_GRID_SEQUENCE_MAX_BYTES / frameBytes);
    throw new RangeError(`bakeGasSimToGrids: ${resolved.frames} frames of ${resolved.resolution.join('x')} take ${frameBytes * resolved.frames} bytes, over the ${VOLUME_GRID_SEQUENCE_MAX_BYTES} byte sequence limit; pass frames up to ${fitting} or a smaller resolution`);
  }
  const names = [];
  runGasSim(resolved, (frame, index) => {
    const name = `${namePrefix}_${String(index).padStart(4, '0')}.67vg`;
    registerVolumeGrid(name, encodeVolumeGrid({ resolution: resolved.resolution, channels: frame, size: resolved.size }));
    names.push(name);
  });
  return names;
}
