import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCharacterController, createChaseCamera, createFlightController, createOrbitCamera, createVehicleController,
} from '../src/player.js';

const STEP_SECONDS = 1 / 60;

// An input whose axes read from a mutable table, so a test can feed one bad sample and then good ones.
function createTableInput(axes = {}) {
  return {
    axes,
    getAxis(name) {
      return this.axes[name] ?? 0;
    },
    isHeld: () => false,
    wasPressed: () => false,
  };
}

function runSteps(system, steps) {
  for (let index = 0; index < steps; index += 1) system.fixedUpdate(STEP_SECONDS);
}

function assertAllFinite(values, label) {
  assert.ok(values.every(Number.isFinite), `${label} must be finite, got ${JSON.stringify(values)}`);
}

test('a vehicle keeps a finite yaw and steer after one non-finite axis sample', () => {
  const input = createTableInput({ moveForward: 1, moveX: Number.NaN });
  const vehicle = createVehicleController({ input });
  runSteps(vehicle, 1);
  input.axes.moveX = 0;
  runSteps(vehicle, 5);
  assertAllFinite([vehicle.state.yaw, vehicle.state.steer, vehicle.state.forwardSpeed], 'vehicle state');
  assertAllFinite(vehicle.state.position, 'vehicle position');
});

test('a flyer keeps a finite yaw, pitch and roll after one non-finite axis sample', () => {
  const input = createTableInput({ moveX: Number.POSITIVE_INFINITY, moveForward: Number.NaN });
  const flyer = createFlightController({ input });
  runSteps(flyer, 1);
  input.axes = {};
  runSteps(flyer, 5);
  assertAllFinite([flyer.state.yaw, flyer.state.pitch, flyer.state.roll, flyer.state.speed], 'flyer state');
  assertAllFinite(flyer.state.position, 'flyer position');
});

test('an orbit camera keeps a finite yaw, pitch and distance after one non-finite look or zoom sample', () => {
  const input = createTableInput({ lookX: Number.NaN, lookY: Number.NaN, zoom: Number.NaN });
  const subject = { position: [0, 0, 0], yaw: 0 };
  const rig = createOrbitCamera({ input, subject, zoom: 'zoom' });
  runSteps(rig, 1);
  input.axes = {};
  runSteps(rig, 5);
  assertAllFinite([rig.yaw, rig.pitch, rig.distance], 'orbit rig');
});

test('a camera rig recovers after its subject reports a non-finite position or yaw for one step', () => {
  const subject = { position: [0, 0, 0], yaw: 0 };
  const rig = createChaseCamera({ subject });
  rig.init();
  subject.position = [Number.NaN, 0, 0];
  subject.yaw = Number.NaN;
  runSteps(rig, 1);
  subject.position = [1, 2, 3];
  subject.yaw = 0.5;
  runSteps(rig, 600);
  assertAllFinite(rig.focus, 'rig focus');
  assertAllFinite([rig.yaw], 'rig yaw');
  assertAllFinite([...rig.pose({ alpha: 1 }).eye], 'rig eye');
});

test('a camera rig refuses a subject whose position is not three finite numbers', () => {
  assert.throws(() => createChaseCamera({ subject: { position: [0, Number.NaN, 0] } }), /subject/);
  assert.throws(() => createChaseCamera({ subject: { position: [0, 0] } }), /subject/);
});

test('a refused teleport leaves the controller exactly where it was', () => {
  const makers = {
    character: () => createCharacterController({ input: createTableInput(), position: [1, 2, 3] }),
    vehicle: () => createVehicleController({ input: createTableInput(), position: [1, 2, 3] }),
    flight: () => createFlightController({ input: createTableInput(), position: [1, 2, 3] }),
  };
  for (const [kind, make] of Object.entries(makers)) {
    const controller = make();
    const before = JSON.stringify(controller.state);
    assert.throws(() => controller.teleport([9, 9, 9], Number.NaN), /teleport yaw/, kind);
    assert.equal(JSON.stringify(controller.state), before, `${kind} state after a refused teleport`);
  }
});
