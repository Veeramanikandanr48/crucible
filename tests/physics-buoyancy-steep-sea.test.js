import test from 'node:test';
import assert from 'node:assert/strict';
import { bakePhysicsScene, loadPhysicsEngine } from '../src/physics.js';

const FRAMES_PER_SECOND = 60;
const SECONDS = 10;
const SEEDS = [1, 5, 9, 13];
const STEEP_SEA_LEVEL = -0.95;

function steepSea(seed) {
  return { windSpeed: 14, choppiness: 2, size: 30, seed, resolution: 5, level: STEEP_SEA_LEVEL };
}

function tiltDegrees(sample) {
  const [x, , z] = sample.slice(3, 6);
  return Math.acos(Math.min(1, Math.abs(1 - 2 * (x * x + z * z)))) * 180 / Math.PI;
}

/** Mean tilt and the share of frames past 45 degrees, from 2 s on, of a body dropped on the steep sea. */
function tiltStatistics(seed, halfExtents, density, translation) {
  const scene = bakePhysicsScene({
    ocean: steepSea(seed),
    bodies: [{ name: 'floater', translation, float: { drag: 1.5, angularDrag: 1.5 } }],
    colliders: [{ name: 'floater', body: 'floater', shape: 'cuboid', halfExtents, density }],
  }, { frameCount: SECONDS * FRAMES_PER_SECOND + 1 });
  let total = 0;
  let steep = 0;
  let count = 0;
  for (let frame = 2 * FRAMES_PER_SECOND; frame <= SECONDS * FRAMES_PER_SECOND; frame++) {
    const tilt = tiltDegrees(scene.sample(frame / FRAMES_PER_SECOND));
    total += tilt;
    if (tilt > 45) steep++;
    count++;
  }
  return { mean: total / count, steepShare: steep / count };
}

function averageOverSeeds(halfExtents, density, translation) {
  const runs = SEEDS.map(seed => tiltStatistics(seed, halfExtents, density, translation));
  return {
    mean: runs.reduce((sum, run) => sum + run.mean, 0) / runs.length,
    steepShare: runs.reduce((sum, run) => sum + run.steepShare, 0) / runs.length,
  };
}

test.before(() => loadPhysicsEngine({ buoyancy: true }));

test('a flat hull on a steep sea does not tumble: it stays under 45 degrees most of the time', () => {
  const { mean, steepShare } = averageOverSeeds([0.9, 0.35, 1.95], 300, [0, 1.5, 0]);
  console.log(`hull: mean tilt ${mean.toFixed(1)}, past 45 ${(steepShare * 100).toFixed(0)}%`);
  assert.ok(mean < 35, `mean tilt ${mean.toFixed(1)} degrees`);
  assert.ok(steepShare < 0.3, `${(steepShare * 100).toFixed(0)}% of frames past 45 degrees`);
});

test('a cube on a steep sea does not stay tipped onto an edge', () => {
  const { mean, steepShare } = averageOverSeeds([0.5, 0.5, 0.5], 500, [0, 0.5, 0]);
  console.log(`cube: mean tilt ${mean.toFixed(1)}, past 45 ${(steepShare * 100).toFixed(0)}%`);
  assert.ok(mean < 27, `mean tilt ${mean.toFixed(1)} degrees`);
  assert.ok(steepShare < 0.25, `${(steepShare * 100).toFixed(0)}% of frames past 45 degrees`);
});
