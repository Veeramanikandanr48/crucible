import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { traceIrradianceGrid } from '../src/irradiance-grid.js';
import { MAX_PROBE_GRID_PARTS, traceProbeMaps } from '../src/probe-trace.js';
import { growToOversizedOperations, shrinkFromOversizedOperations, largeRoom, oversizedRoom } from './support/agent-bake-rooms.mjs';

const FITTING_BAKE = { samples: 8, bounces: 1, texelsPerUnit: 2 };
const OVER_THE_PATH_WORK_LIMIT = { samples: 32, bounces: 2, texelsPerUnit: 3 };

function tooManyParts() {
  return Array.from({ length: MAX_PROBE_GRID_PARTS + 1 }, () => ({}));
}

test('the irradiance grid and the probes say they trace on the CPU and name their own part cap', () => {
  for (const trace of [() => traceIrradianceGrid(tooManyParts(), {}), () => traceProbeMaps(tooManyParts(), {}, [[0, 0, 0]])]) {
    assert.throws(trace, error => error instanceof RangeError
      && error.message.includes(`1 to ${MAX_PROBE_GRID_PARTS} parts`)
      && /on the CPU/.test(error.message));
  }
});

test('an edit whose rebake cannot run stays applied, drops the old bake and warns how to fit', () => {
  const scene = createAgentScene(largeRoom(FITTING_BAKE));
  assert.ok(scene.inspect().bake, 'the fitting bake runs');
  const bakedFloor = scene.parts.find(part => part.material.emissiveMap);
  assert.ok(bakedFloor, 'a part carries a lightmap');

  scene.apply([{ type: 'set-bake', bake: OVER_THE_PATH_WORK_LIMIT }, { type: 'set-camera', fov: 33 }, ...growToOversizedOperations(OVER_THE_PATH_WORK_LIMIT)], { expectedRevision: 0 });
  const inspected = scene.inspect();
  assert.equal(inspected.revision, 1);
  assert.equal(inspected.bake, undefined, 'the old bake is dropped');
  assert.equal(scene.parts.some(part => part.material.emissiveMap), false, 'no part keeps the old lightmap');
  const warning = inspected.diagnostics.find(diagnostic => diagnostic.kind === 'bake-skipped');
  assert.equal(warning.severity, 'warning');
  assert.match(warning.message, /texels/);
  assert.match(warning.fix, /fewer parts|lower bake\.samples/);

  scene.apply([{ type: 'set-camera', fov: 40 }], { expectedRevision: 1 });
  assert.ok(scene.inspect().diagnostics.some(diagnostic => diagnostic.kind === 'bake-skipped'), 'an unrelated edit keeps the warning');

  scene.apply([{ type: 'set-bake', bake: FITTING_BAKE }, ...shrinkFromOversizedOperations(FITTING_BAKE)], { expectedRevision: 2 });
  const recovered = scene.inspect();
  assert.ok(recovered.bake, 'a bake that fits runs again');
  assert.equal((recovered.diagnostics ?? []).some(diagnostic => diagnostic.kind === 'bake-skipped'), false);
});

test('a scene whose first bake cannot run still fails to build', () => {
  assert.throws(() => createAgentScene(oversizedRoom(OVER_THE_PATH_WORK_LIMIT)), /Even samples 16, bounces 1 and texelsPerUnit 1 is \d+ texels/);
});
