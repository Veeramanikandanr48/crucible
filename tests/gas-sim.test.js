// The grid gas simulation (#1735): determinism, a rising plume, mass, vorticity detail, option bounds and the grid files it writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bakeGasSim, bakeGasSimToGrids, GAS_SIM_TEMPERATURE_UNIT } from '../src/gas-sim.js';
import { findVolumeGrid, volumeGridFloats, encodeVolumeGrid } from '../src/volume-grid.js';

const SMALL = { resolution: 32 };

function frameHashes(bake) {
  return bake.frames.map(frame => createHash('sha256')
    .update(Buffer.from(frame.density.buffer))
    .update(Buffer.from(frame.temperature.buffer))
    .update(Buffer.from(frame.flame.buffer))
    .digest('hex'));
}

function totalDensity(frame) {
  let total = 0;
  for (const value of frame.density) total += value;
  return total;
}

// Mean and spread of detailed density over plain density across the cells that hold smoke, and how many empty cells stayed empty.
function modulationStatistics(plainFrame, detailedFrame) {
  const ratios = [];
  let filledEmptyCells = 0;
  plainFrame.density.forEach((plainDensity, index) => {
    if (plainDensity === 0) filledEmptyCells += detailedFrame.density[index] === 0 ? 0 : 1;
    else if (plainDensity > 0.01) ratios.push(detailedFrame.density[index] / plainDensity);
  });
  const mean = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  const spread = Math.sqrt(ratios.reduce((sum, ratio) => sum + (ratio - mean) ** 2, 0) / ratios.length);
  return { mean, spread, filledEmptyCells, count: ratios.length };
}

function densityCentroidHeight(frame, bake) {
  const [nx, ny] = bake.resolution;
  const cellSize = bake.size[0] / nx;
  let weighted = 0;
  let total = 0;
  frame.density.forEach((value, index) => {
    weighted += value * (Math.floor(index / nx) % ny + 0.5) * cellSize;
    total += value;
  });
  return weighted / total;
}

// Perimeter over the square root of the area of the thresholded smoke in one horizontal slice: a smooth blob is low, a ragged one high.
function silhouetteRoughness(frame, bake, sliceY, threshold) {
  const [nx, ny, nz] = bake.resolution;
  const inside = (x, z) => x >= 0 && z >= 0 && x < nx && z < nz && frame.density[x + nx * (sliceY + ny * z)] > threshold;
  let area = 0;
  let perimeter = 0;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      if (!inside(x, z)) continue;
      area++;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!inside(x + dx, z + dz)) perimeter++;
    }
  }
  assert.ok(area > 20, `the slice holds ${area} smoke cells, too few to measure`);
  return perimeter / Math.sqrt(area);
}

test('the same options give identical bytes for every frame, another seed does not', () => {
  const first = frameHashes(bakeGasSim({ ...SMALL, frames: 6, seed: 7 }));
  const again = frameHashes(bakeGasSim({ ...SMALL, frames: 6, seed: 7 }));
  const other = frameHashes(bakeGasSim({ ...SMALL, frames: 6, seed: 8 }));
  assert.deepEqual(first, again);
  assert.equal(new Set(first).size, 6, 'every frame differs from the others');
  first.forEach((hash, index) => assert.notEqual(hash, other[index], `frame ${index} ignores the seed`));
});

// The bytes a bake wrote before the advection located each traced position once per step (#1768): every grid an explosion names must keep them.
test('a bake with velocity keeps the exact bytes it had before positions were located once per step', () => {
  const baked = bakeGasSim({ resolution: 24, frames: 8, seed: 7, velocity: true });
  const hash = createHash('sha256');
  for (const frame of baked.frames) {
    for (const channel of Object.keys(frame).sort()) hash.update(Buffer.from(frame[channel].buffer));
  }
  assert.equal(hash.digest('hex'), 'af906fb809df1d869d7008851c1325dbdddda7eb223e4838ca249c63d8ccaf9d');
});

// The default small bake, shared by the plume, burning and timing tests: the frames before frame 24 do not depend on how many frames are asked
// for, so one 36 frame bake serves all three.
let defaultBakePromise = null;
let defaultBakeSeconds = 0;
function defaultSmallBake() {
  defaultBakePromise ??= Promise.resolve().then(() => {
    const started = performance.now();
    const bake = bakeGasSim({ ...SMALL, frames: 36 });
    defaultBakeSeconds = (performance.now() - started) / 1000;
    return bake;
  });
  return defaultBakePromise;
}

test('the plume rises over the first second', async () => {
  const bake = await defaultSmallBake();
  const early = densityCentroidHeight(bake.frames[5], bake);
  const late = densityCentroidHeight(bake.frames[23], bake);
  assert.ok(late > early + 0.5, `the smoke centroid went from ${early.toFixed(2)} m to ${late.toFixed(2)} m`);
  assert.equal(bake.fps, 24);
  assert.deepEqual(bake.size, [4, 4, 4]);
});

// A burst, then 3 s with the source off: no fuel to burn, so the only thing that can change the smoke mass is the solver. The 8 m box keeps
// the plume inside, so nothing leaves through the open sides or the top.
const NO_SOURCE = { ...SMALL, frames: 72, burstFuel: 0, cellSize: 0.25 };
const FIRST_QUIET_FRAME = 10;

for (const advection of ['maccormack', 'semi-lagrangian']) {
  test(`smoke mass stays constant for 72 frames with no source and no dissipation (${advection})`, () => {
    const bake = bakeGasSim({ ...NO_SOURCE, dissipation: 0, advection });
    const afterBurst = totalDensity(bake.frames[FIRST_QUIET_FRAME]);
    for (const frame of [20, 40, 71]) {
      const drift = totalDensity(bake.frames[frame]) / afterBurst - 1;
      assert.ok(Math.abs(drift) < 0.02, `mass drifted ${(drift * 100).toFixed(2)}% by frame ${frame}`);
    }
  });
}

test('smoke mass decays by the dissipation factor and by nothing else', () => {
  const rate = 0.4;
  const bake = bakeGasSim({ ...NO_SOURCE, dissipation: rate });
  const seconds = (71 - FIRST_QUIET_FRAME) / bake.fps;
  const expected = Math.exp(-rate * seconds);
  const measured = totalDensity(bake.frames[71]) / totalDensity(bake.frames[FIRST_QUIET_FRAME]);
  assert.ok(Math.abs(measured / expected - 1) < 0.02, `mass fell to ${measured.toFixed(4)} of its value, expected ${expected.toFixed(4)}`);
});

test('smoke that rises out of a small box only ever leaves, it is never made', () => {
  const bake = bakeGasSim({ ...SMALL, frames: 72, burstFuel: 0, dissipation: 0 });
  const afterBurst = totalDensity(bake.frames[FIRST_QUIET_FRAME]);
  let previous = afterBurst;
  bake.frames.slice(FIRST_QUIET_FRAME).forEach((frame, index) => {
    const mass = totalDensity(frame);
    assert.ok(mass <= previous * 1.005, `mass grew from ${previous.toFixed(2)} to ${mass.toFixed(2)} at frame ${FIRST_QUIET_FRAME + index}`);
    previous = mass;
  });
  assert.ok(previous < afterBurst * 0.98, 'the plume should have left the 4 m box by the end');
});

test('vorticity confinement makes the silhouette more ragged', () => {
  const settings = { resolution: 40, frames: 24, burstFuel: 0 };
  const smooth = bakeGasSim({ ...settings, vorticity: 0 });
  const confined = bakeGasSim({ ...settings, vorticity: 8 });
  const smoothRoughness = silhouetteRoughness(smooth.frames[23], smooth, 12, 0.15);
  const confinedRoughness = silhouetteRoughness(confined.frames[23], confined, 12, 0.15);
  assert.ok(confinedRoughness > smoothRoughness * 1.3, `roughness ${smoothRoughness.toFixed(2)} without, ${confinedRoughness.toFixed(2)} with confinement`);
});

test('burning makes flame and heat that die away', async () => {
  const bake = await defaultSmallBake();
  const peak = frame => Math.max(...frame.flame);
  assert.ok(peak(bake.frames[3]) > 0.05, 'the burst burns');
  assert.ok(peak(bake.frames[35]) < peak(bake.frames[3]) * 0.2, 'the flame dies away');
  const hottest = Math.max(...bake.frames[0].temperature);
  assert.ok(hottest > 1 && hottest < 5, `the burst is ${hottest * GAS_SIM_TEMPERATURE_UNIT} K above ambient, grid units of ${GAS_SIM_TEMPERATURE_UNIT} K`);
  assert.ok(Math.max(...bake.frames[35].temperature) < hottest * 0.7, 'the heat cools');
});

test('every option bound throws an error that names the field and its range', () => {
  const cases = [
    [{ resolution: 7 }, /resolution.*8 to 96/],
    [{ resolution: [32, 97, 32] }, /resolution.*8 to 96/],
    [{ resolution: [32, 32] }, /resolution.*\[x, y, z\]/],
    [{ frames: 0 }, /frames.*1 to 240/],
    [{ frames: 241 }, /frames.*1 to 240/],
    [{ frames: 2.5 }, /frames.*integer/],
    [{ fps: 0 }, /fps.*1 to 120/],
    [{ fps: Number.NaN }, /fps.*1 to 120/],
    [{ substeps: 9 }, /substeps.*1 to 8/],
    [{ maxSeconds: 0 }, /maxSeconds.*0\.1 to 3600/],
    [{ pressureIterations: 3 }, /pressureIterations.*4 to 100/],
    [{ advection: 'rk4' }, /advection.*maccormack, semi-lagrangian/],
    [{ burstPosition: [99, 0, 1] }, /burstPosition\[0\].*0 to 8/],
    [{ burstRadius: 0 }, /burstRadius.*0\.05 to 20/]
  ];
  for (const [options, message] of cases) {
    assert.throws(() => bakeGasSim({ frames: 1, ...options }), message, JSON.stringify(options));
  }
});

test('maxSeconds stops a bake that runs over its budget', () => {
  assert.throws(() => bakeGasSim({ resolution: 64, frames: 40, maxSeconds: 0.1 }), /maxSeconds 0\.1 passed.*of 40/);
});

test('bakeGasSimToGrids registers one grid per frame that a grid volume can play', () => {
  const names = bakeGasSimToGrids({ ...SMALL, frames: 3 }, 'gastest');
  assert.deepEqual(names, ['gastest_0000.67vg', 'gastest_0001.67vg', 'gastest_0002.67vg']);
  const grid = findVolumeGrid(names[2], 'test');
  assert.deepEqual(grid.resolution, [32, 32, 32]);
  assert.deepEqual(grid.size, [4, 4, 4]);
  const floats = volumeGridFloats(grid);
  assert.ok(floats.temperature && floats.flame, 'density, temperature and flame are written');
  assert.ok(Math.max(...floats.density) > 0.1);
  const direct = bakeGasSim({ ...SMALL, frames: 3 }).frames[2];
  const expected = encodeVolumeGrid({ resolution: [32, 32, 32], channels: direct, size: [4, 4, 4] });
  assert.equal(expected.length, 12 + Math.ceil(JSON.stringify({ resolution: [32, 32, 32], channels: ['density', 'temperature', 'flame'], size: [4, 4, 4] }).length / 4) * 4 + 32 ** 3 * 6);
  assert.throws(() => bakeGasSimToGrids({ resolution: 96, frames: 240 }, 'toobig'), /sequence limit.*frames up to/);
  assert.throws(() => bakeGasSimToGrids({}, ''), /namePrefix/);
});

test('a 32 cubed bake of 36 frames takes a few seconds', async t => {
  await defaultSmallBake();
  t.diagnostic(`32^3 x 36 frames: ${defaultBakeSeconds.toFixed(2)} s`);
});

test('detail 0 leaves the bake byte for byte as it was and detail adds small puffs without moving the cloud', () => {
  const options = { resolution: 32, frames: 24, seed: 5 };
  const plain = bakeGasSim(options);
  const explicitZero = bakeGasSim({ ...options, detail: 0 });
  assert.deepEqual(frameHashes(explicitZero), frameHashes(plain));

  const detailed = bakeGasSim({ ...options, detail: 1 });
  assert.deepEqual(frameHashes(bakeGasSim({ ...options, detail: 1 })), frameHashes(detailed), 'the same seed gives the same bytes');
  assert.notDeepEqual(frameHashes(detailed), frameHashes(plain));

  const lastIndex = options.frames - 1;
  const plainMass = totalDensity(plain.frames[lastIndex]);
  const detailedMass = totalDensity(detailed.frames[lastIndex]);
  assert.ok(Math.abs(detailedMass / plainMass - 1) < 0.15, `noise keeps the smoke mass within 15 percent, got ${detailedMass / plainMass}`);
  assert.ok(Math.abs(densityCentroidHeight(detailed.frames[lastIndex], detailed) - densityCentroidHeight(plain.frames[lastIndex], plain)) < 0.4, 'the cloud stays where the sim put it');
  for (const value of detailed.frames[lastIndex].density) assert.ok(Number.isFinite(value) && value >= 0);

  const statistics = modulationStatistics(plain.frames[lastIndex], detailed.frames[lastIndex]);
  assert.ok(statistics.count > 500, `the frame holds smoke to measure, got ${statistics.count} cells`);
  assert.ok(statistics.spread > 0.2, `detail 1 mottles the smoke, got a spread of ${statistics.spread}`);
  assert.ok(Math.abs(statistics.mean - 1) < 0.15, `the mean stays near 1, got ${statistics.mean}`);
  assert.equal(statistics.filledEmptyCells, 0, 'empty cells stay empty');
});

test('detail is checked and the velocity channels are not warped', () => {
  assert.throws(() => bakeGasSim({ resolution: 16, frames: 1, detail: 2 }), /detail must be a number from 0 to 1/);
  const withVelocity = bakeGasSim({ resolution: 16, frames: 2, velocity: true, detail: 1 });
  const plainVelocity = bakeGasSim({ resolution: 16, frames: 2, velocity: true });
  assert.deepEqual(withVelocity.frames[1].velocityX, plainVelocity.frames[1].velocityX);
});
