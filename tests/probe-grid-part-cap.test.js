import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_BAKE_PARTS } from '../src/light-bake.js';
import { traceIrradianceGrid } from '../src/irradiance-grid.js';
import { MAX_PROBE_GRID_PARTS, traceObjectProbes, traceProbeMaps } from '../src/probe-trace.js';
import { manyPartInterior } from './support/many-part-interior.mjs';

const sun = { keyColor: [3, 3, 3], lightDirection: [0.2, 1, 0.1] };
const LARGER_THAN_THE_LIGHTMAP_CAP = MAX_BAKE_PARTS + 44;

function brightness(data) {
  return data.reduce((total, value) => total + value, 0);
}

test('probes and the irradiance grid have their own cap, above the lightmap cap (#1218)', () => {
  assert.ok(MAX_PROBE_GRID_PARTS > MAX_BAKE_PARTS);
  assert.equal(manyPartInterior(LARGER_THAN_THE_LIGHTMAP_CAP).length, LARGER_THAN_THE_LIGHTMAP_CAP);
});

test('a 300 part interior bakes an irradiance grid with light in it (#1218)', () => {
  const grid = traceIrradianceGrid(manyPartInterior(LARGER_THAN_THE_LIGHTMAP_CAP), sun, { resolution: 10, samples: 4, bounces: 1 });
  assert.ok(grid.nodes > 0 && brightness(grid.data) > 0);
});

test('a 300 part interior bakes light probes (#1218)', () => {
  const roofless = manyPartInterior(LARGER_THAN_THE_LIGHTMAP_CAP).filter(part => part.name !== 'ceiling');
  const [map] = traceProbeMaps(roofless, sun, [[0, 1.5, 0]], { width: 16, samples: 4, bounces: 1 });
  assert.ok(brightness(map.data) > 0);
});

test('a smooth metal part in a 300 part interior gets an object probe instead of being skipped (#1218)', () => {
  const parts = manyPartInterior(LARGER_THAN_THE_LIGHTMAP_CAP);
  parts[10].material = { ...parts[10].material, metallic: 1, roughness: 0.1 };
  const result = traceObjectProbes(parts, sun, { samples: 4, bounces: 1, width: 16 });
  assert.equal(result.skipped, null);
  assert.equal(result.traced.length, 1);
});

test('more parts than the probe and grid cap are refused with the cap in the message (#1218)', () => {
  const crowd = Array.from({ length: MAX_PROBE_GRID_PARTS + 1 }, () => ({}));
  assert.throws(() => traceIrradianceGrid(crowd, sun), error => error instanceof RangeError && error.message.includes(`1 to ${MAX_PROBE_GRID_PARTS} parts`));
  assert.throws(() => traceProbeMaps(crowd, sun, [[0, 0, 0]]), error => error instanceof RangeError && error.message.includes(`1 to ${MAX_PROBE_GRID_PARTS} parts`));
});
