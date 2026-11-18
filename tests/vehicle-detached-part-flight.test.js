import test from 'node:test';
import assert from 'node:assert/strict';
import { detachedPartFlight, crashImpulse } from '../src/vehicle.js';

const BUMPER = { id: 'front-bumper', threshold: 9000, mass: 12, position: [0, 0.5, 2] };
const WALL_HIT = { impulse: crashImpulse({ mass: 1400, speed: 12 }), direction: [0, 0, -1], point: [0, 0.5, 2.1] };

test('a part below its threshold stays on, and one above it flies off', () => {
  assert.equal(detachedPartFlight(BUMPER, { impulse: 8999, direction: [0, 0, -1] }), null);
  const flight = detachedPartFlight(BUMPER, WALL_HIT, { seed: 7 });
  assert.equal(flight.id, 'front-bumper');
  const later = flight.sample(0.5);
  assert.ok(Math.abs(later.position[0]) > 1, `moved ${later.position}`);
});

test('the same seed gives the same transform, a different seed another', () => {
  const first = detachedPartFlight(BUMPER, WALL_HIT, { seed: 7 }).sample(1.25);
  const second = detachedPartFlight(BUMPER, WALL_HIT, { seed: 7 }).sample(1.25);
  const other = detachedPartFlight(BUMPER, WALL_HIT, { seed: 8 }).sample(1.25);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.rotation, other.rotation);
});

test('a harder hit throws the part faster, and it comes to rest on the ground', () => {
  const soft = detachedPartFlight(BUMPER, { impulse: 12000, direction: [0, 0, -1] }, { seed: 1 });
  const hard = detachedPartFlight(BUMPER, { impulse: 30000, direction: [0, 0, -1] }, { seed: 1 });
  assert.ok(Math.hypot(...hard.launchVelocity) > Math.hypot(...soft.launchVelocity));
  const rest = hard.sample(30);
  assert.equal(rest.settled, true);
  assert.equal(rest.position[1], 0);
});

test('bad input says what to pass instead', () => {
  assert.throws(() => detachedPartFlight({ ...BUMPER, mass: 0 }, WALL_HIT), /part\.mass/);
  assert.throws(() => detachedPartFlight(BUMPER, { impulse: 1, direction: [0, 0, 0] }), /hit\.direction/);
  assert.throws(() => detachedPartFlight(BUMPER, WALL_HIT, { restitution: 2 }), /restitution/);
  assert.throws(() => detachedPartFlight(BUMPER, WALL_HIT).sample(31), /time/);
});

test('the part never crosses the wall and rests beside the nose', () => {
  for (const seed of [1, 2, 3, 4]) {
    const flight = detachedPartFlight(BUMPER, WALL_HIT, { seed });
    for (let step = 0; step <= 30 * 60; step++) {
      const position = flight.sample(step / 60).position;
      const behindWall = (position[2] - WALL_HIT.point[2]) * WALL_HIT.direction[2];
      assert.ok(behindWall >= -1e-6, `seed ${seed} step ${step} crossed the wall by ${behindWall}`);
      if (flight.sample(step / 60).settled) break;
    }
    const rest = flight.sample(30);
    assert.equal(rest.settled, true);
    const sidewaysOffset = Math.abs(rest.position[0] - BUMPER.position[0]);
    const reboundDistance = (rest.position[2] - BUMPER.position[2]) * WALL_HIT.direction[2];
    assert.ok(sidewaysOffset > reboundDistance, `seed ${seed} sideways ${sidewaysOffset} rebound ${reboundDistance}`);
    assert.ok(flight.launchVelocity[1] > 0);
  }
});

test('a part thrown at the wall is held on the car side of its plane', () => {
  const towardWall = detachedPartFlight({ ...BUMPER, position: [0, 0.5, 2.09] }, { ...WALL_HIT, direction: [0, 0, -1], point: [0, 0.5, 2.1] }, { seed: 2 });
  assert.ok(towardWall.sample(1).position[2] <= 2.1 + 1e-6);
});

const SIZED_BUMPER = { ...BUMPER, position: [0, 0.5, 1.95], size: [1.7, 0.35, 0.2] };

function boxCorners(position, rotation, size) {
  const [x, y, z] = rotation;
  const turn = ([vx, vy, vz]) => {
    const aroundZ = [vx * Math.cos(z) - vy * Math.sin(z), vx * Math.sin(z) + vy * Math.cos(z), vz];
    const aroundY = [aroundZ[0] * Math.cos(y) + aroundZ[2] * Math.sin(y), aroundZ[1], -aroundZ[0] * Math.sin(y) + aroundZ[2] * Math.cos(y)];
    return [aroundY[0], aroundY[1] * Math.cos(x) - aroundY[2] * Math.sin(x), aroundY[1] * Math.sin(x) + aroundY[2] * Math.cos(x)];
  };
  const corners = [];
  for (const signX of [-1, 1]) for (const signY of [-1, 1]) for (const signZ of [-1, 1]) {
    const offset = turn([signX * size[0] / 2, signY * size[1] / 2, signZ * size[2] / 2]);
    corners.push(offset.map((component, axis) => position[axis] + component));
  }
  return corners;
}

test('no corner of a sized part crosses the wall plane, for 4 seeds, every 1/60 s', () => {
  for (const seed of [1, 2, 3, 4]) {
    const flight = detachedPartFlight(SIZED_BUMPER, WALL_HIT, { seed });
    for (let step = 0; step <= 10 * 60; step++) {
      const sample = flight.sample(step / 60);
      for (const corner of boxCorners(sample.position, sample.rotation, SIZED_BUMPER.size)) {
        const behindWall = (corner[2] - WALL_HIT.point[2]) * WALL_HIT.direction[2];
        assert.ok(behindWall >= -1e-6, `seed ${seed} step ${step} corner ${corner} is ${behindWall} past the wall`);
      }
    }
  }
});

test('a part with a size is checked and one without keeps the centre-only hold', () => {
  assert.throws(() => detachedPartFlight({ ...BUMPER, size: [1, 0, 1] }, WALL_HIT), /part\.size/);
  assert.throws(() => detachedPartFlight({ ...BUMPER, size: [1, 1] }, WALL_HIT), /part\.size/);
  assert.ok(detachedPartFlight(BUMPER, WALL_HIT, { seed: 1 }).sample(1));
});

test('a sized part never sinks into the ground and lies on a face at rest, for 4 seeds, every 1/60 s', () => {
  const groundY = 0.1;
  for (const seed of [1, 2, 3, 4]) {
    const flight = detachedPartFlight(SIZED_BUMPER, WALL_HIT, { seed, groundY });
    for (let step = 0; step <= 10 * 60; step++) {
      const sample = flight.sample(step / 60);
      const lowest = Math.min(...boxCorners(sample.position, sample.rotation, SIZED_BUMPER.size).map(corner => corner[1]));
      assert.ok(lowest >= groundY - 1e-6, `seed ${seed} step ${step} lowest corner ${lowest} is below the ground`);
    }
    const rest = flight.sample(30);
    assert.equal(rest.settled, true);
    const heights = boxCorners(rest.position, rest.rotation, SIZED_BUMPER.size).map(corner => corner[1]);
    const lowest = Math.min(...heights);
    const standing = Math.max(...heights) - lowest;
    assert.ok(Math.abs(lowest - groundY) < 1e-6, `seed ${seed} rests with its lowest corner at ${lowest}`);
    assert.ok(SIZED_BUMPER.size.some(extent => Math.abs(standing - extent) < 1e-6), `seed ${seed} rests ${standing} tall, not on a face`);
    for (const corner of boxCorners(rest.position, rest.rotation, SIZED_BUMPER.size)) {
      assert.ok((corner[2] - WALL_HIT.point[2]) * WALL_HIT.direction[2] >= -1e-6, `seed ${seed} rests across the wall`);
    }
  }
});

const SEEDS = Array.from({ length: 32 }, (_, index) => index + 1);

function restingExtent(rest) {
  const heights = boxCorners(rest.position, rest.rotation, SIZED_BUMPER.size).map(corner => corner[1]);
  return Math.max(...heights) - Math.min(...heights);
}

test('a sized bumper rests on its largest face in most of 32 seeds', () => {
  const facesByExtent = {};
  for (const seed of SEEDS) {
    const rest = detachedPartFlight(SIZED_BUMPER, WALL_HIT, { seed }).sample(30);
    const extent = restingExtent(rest).toFixed(2);
    facesByExtent[extent] = (facesByExtent[extent] ?? 0) + 1;
  }
  console.log('resting vertical extent (m): seed count', JSON.stringify(facesByExtent));
  assert.ok((facesByExtent['0.20'] ?? 0) >= 24, `only ${facesByExtent['0.20'] ?? 0} of ${SEEDS.length} seeds rest on the 0.2 m face: ${JSON.stringify(facesByExtent)}`);
  assert.equal(facesByExtent['1.70'] ?? 0, 0, `a seed stands on its end: ${JSON.stringify(facesByExtent)}`);
});

test('for 16 seeds the lowest corner stays on or above the ground every 1/60 s, the wall holds, and rest is on a face', () => {
  for (const seed of SEEDS.slice(0, 16)) {
    const flight = detachedPartFlight(SIZED_BUMPER, WALL_HIT, { seed, groundY: 0 });
    for (let step = 0; step <= 10 * 60; step++) {
      const sample = flight.sample(step / 60);
      for (const corner of boxCorners(sample.position, sample.rotation, SIZED_BUMPER.size)) {
        assert.ok(corner[1] >= -1e-6, `seed ${seed} step ${step} corner height ${corner[1]}`);
        assert.ok((corner[2] - WALL_HIT.point[2]) * WALL_HIT.direction[2] >= -1e-6, `seed ${seed} step ${step} corner past the wall`);
      }
    }
    const rest = flight.sample(30);
    const heights = boxCorners(rest.position, rest.rotation, SIZED_BUMPER.size).map(corner => corner[1]);
    assert.ok(Math.abs(Math.min(...heights)) < 1e-6, `seed ${seed} lowest corner ${Math.min(...heights)}`);
    const extent = Math.max(...heights) - Math.min(...heights);
    assert.ok(SIZED_BUMPER.size.some(side => Math.abs(extent - side) < 1e-6), `seed ${seed} rests ${extent} tall`);
  }
});
