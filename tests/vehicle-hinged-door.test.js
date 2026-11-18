import test from 'node:test';
import assert from 'node:assert/strict';
import { hingedDoorSwing } from '../src/vehicle.js';

const DOOR = { id: 'door-right', threshold: 9000, mass: 20, position: [0.9, 0.6, 0.4], size: [0.05, 0.8, 1] };
const HINGE = { point: [0.9, 0.6, 0.9], axis: [0, 1, 0] };
const HIT = { impulse: 16800, direction: [1, 0, 0], point: [0.9, 0.6, -0.05] };
const FRAME_SECONDS = 1 / 60;

function rotateByQuaternion(vector, [x, y, z, w]) {
  const crossed = [y * vector[2] - z * vector[1], z * vector[0] - x * vector[2], x * vector[1] - y * vector[0]];
  const crossedAgain = [y * crossed[2] - z * crossed[1], z * crossed[0] - x * crossed[2], x * crossed[1] - y * crossed[0]];
  return [0, 1, 2].map(index => vector[index] + 2 * (w * crossed[index] + crossedAgain[index]));
}

function rotateByEuler([angleX, angleY, angleZ], vector) {
  const [x, y, z] = vector;
  const aroundZ = [x * Math.cos(angleZ) - y * Math.sin(angleZ), x * Math.sin(angleZ) + y * Math.cos(angleZ), z];
  const aroundY = [aroundZ[0] * Math.cos(angleY) + aroundZ[2] * Math.sin(angleY), aroundZ[1], -aroundZ[0] * Math.sin(angleY) + aroundZ[2] * Math.cos(angleY)];
  return [aroundY[0], aroundY[1] * Math.cos(angleX) - aroundY[2] * Math.sin(angleX), aroundY[1] * Math.sin(angleX) + aroundY[2] * Math.cos(angleX)];
}

function everyFrame(swing, seconds = 4) {
  const samples = [];
  for (let frame = 0; frame * FRAME_SECONDS <= seconds; frame++) samples.push(swing.sample(frame * FRAME_SECONDS));
  return samples;
}

test('a door below its threshold stays shut, and one above it swings', () => {
  assert.equal(hingedDoorSwing(DOOR, { ...HIT, impulse: 8999 }, { hinge: HINGE }), null);
  const swing = hingedDoorSwing(DOOR, HIT, { hinge: HINGE, seed: 7 });
  assert.equal(swing.id, 'door-right');
  assert.equal(swing.sample(0).angle, 0);
  assert.ok(Math.abs(swing.sample(0.2).angle) > 0.3, `angle ${swing.sample(0.2).angle}`);
});

test('the same seed gives the same samples, a different seed another speed', () => {
  const first = everyFrame(hingedDoorSwing(DOOR, HIT, { hinge: HINGE, seed: 7 }));
  const second = everyFrame(hingedDoorSwing(DOOR, HIT, { hinge: HINGE, seed: 7 }));
  assert.deepEqual(first, second);
  const other = hingedDoorSwing(DOOR, HIT, { hinge: HINGE, seed: 8 });
  assert.notEqual(other.initialAngularVelocity, hingedDoorSwing(DOOR, HIT, { hinge: HINGE, seed: 7 }).initialAngularVelocity);
});

test('a harder hit swings the door faster', () => {
  const soft = hingedDoorSwing(DOOR, { ...HIT, impulse: 12000 }, { hinge: HINGE, seed: 1 });
  const hard = hingedDoorSwing(DOOR, { ...HIT, impulse: 16800 }, { hinge: HINGE, seed: 1 });
  assert.ok(Math.abs(hard.initialAngularVelocity) > Math.abs(soft.initialAngularVelocity));
  assert.ok(Math.abs(hard.sample(0.1).angle) > Math.abs(soft.sample(0.1).angle));
});

test('the angle never passes maxAngle at any step, and a strong hit reaches the stop', () => {
  const swing = hingedDoorSwing(DOOR, HIT, { hinge: HINGE, maxAngle: 40, damping: 1 });
  const limit = (40 * Math.PI) / 180;
  const angles = everyFrame(swing, 8).map(sample => Math.abs(sample.angle));
  assert.ok(Math.max(...angles) <= limit + 1e-12, `max ${Math.max(...angles)}`);
  let deepest = 0;
  for (let time = 0; time < 1; time += 0.001) deepest = Math.max(deepest, Math.abs(swing.sample(time).angle));
  assert.ok(deepest > limit - 1e-9, `deepest ${deepest}`);
  assert.ok(angles.at(-1) > limit * 0.5, 'it rests open, not shut');
});

test('the door never swings back past shut, whatever the damping', () => {
  const swing = hingedDoorSwing(DOOR, HIT, { hinge: HINGE, maxAngle: 40, damping: 0 });
  const direction = Math.sign(swing.initialAngularVelocity);
  for (const sample of everyFrame(swing, 10)) assert.ok(sample.angle * direction >= 0, `angle ${sample.angle}`);
});

test('a closed stop (maxAngle 0) keeps the door shut', () => {
  const samples = everyFrame(hingedDoorSwing(DOOR, HIT, { hinge: HINGE, maxAngle: 0 }), 1);
  assert.ok(samples.every(sample => sample.angle === 0));
});

test('the hinge edge stays on the hinge axis at every step', () => {
  const swing = hingedDoorSwing(DOOR, { ...HIT, impulse: 16800 }, { hinge: { point: [0.9, 0.6, 0.9], axis: [0, 2, 0] } });
  const hingeOffsetFromCentre = [0, 0, 0.5];
  for (const sample of everyFrame(swing)) {
    const edge = rotateByQuaternion(hingeOffsetFromCentre, sample.quaternion).map((component, index) => component + sample.position[index]);
    const distanceFromAxis = Math.hypot(edge[0] - 0.9, edge[2] - 0.9);
    assert.ok(distanceFromAxis < 1e-6, `edge ${edge}`);
  }
});

test('the Euler rotation turns the door like its quaternion', () => {
  const swing = hingedDoorSwing(DOOR, HIT, { hinge: { point: [0.9, 0.6, 0.9], axis: [1, 2, 3] }, seed: 3 });
  const sample = swing.sample(0.15);
  assert.ok(Math.abs(sample.angle) > 0.1);
  const byQuaternion = rotateByQuaternion([0.3, -0.2, 0.7], sample.quaternion);
  const byEuler = rotateByEuler(sample.rotation, [0.3, -0.2, 0.7]);
  byEuler.forEach((component, index) => assert.ok(Math.abs(component - byQuaternion[index]) < 1e-9));
});

test('the door slows, comes to rest and stays there', () => {
  const swing = hingedDoorSwing(DOOR, HIT, { hinge: HINGE, maxAngle: 100, damping: 5 });
  const rest = swing.sample(30);
  assert.equal(rest.settled, true);
  assert.equal(rest.angularVelocity, 0);
  assert.deepEqual(swing.sample(20), swing.sample(30));
  assert.equal(swing.sample(0.01).settled, false);
});

test('bad input says what to pass instead', () => {
  assert.throws(() => hingedDoorSwing(DOOR, HIT, {}), /hinge/);
  assert.throws(() => hingedDoorSwing(DOOR, HIT, { hinge: { point: [0, 0, 0], axis: [0, 0, 0] } }), /hinge\.axis/);
  assert.throws(() => hingedDoorSwing(DOOR, HIT, { hinge: { point: [0.9, 0.6, 0.4], axis: [0, 1, 0] } }), /hinge\.point/);
  assert.throws(() => hingedDoorSwing(DOOR, HIT, { hinge: HINGE, maxAngle: 171 }), /maxAngle/);
  assert.throws(() => hingedDoorSwing(DOOR, HIT, { hinge: HINGE, damping: -1 }), /damping/);
  assert.throws(() => hingedDoorSwing({ ...DOOR, mass: 0 }, HIT, { hinge: HINGE }), /part\.mass/);
  assert.throws(() => hingedDoorSwing(DOOR, { ...HIT, direction: [0, 0, 0] }, { hinge: HINGE }), /hit\.direction/);
  assert.throws(() => hingedDoorSwing(DOOR, HIT, { hinge: HINGE }).sample(31), /time/);
});
