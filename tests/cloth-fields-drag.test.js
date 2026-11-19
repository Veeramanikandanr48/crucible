import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeClothWithFields } from '../src/cloth-fields.js';
import { normalizeForceFields } from '../src/force-fields.js';

const POSITIONS = Float64Array.from([0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0.1, 0, 0.1]);
const TRIANGLES = Uint32Array.from([0, 2, 1, 1, 2, 3]);

function fallHeights(strength) {
  const fields = normalizeForceFields([{ type: 'drag', strength }], 'Cloth force field');
  const frames = bakeClothWithFields(POSITIONS, TRIANGLES, { fields, frameCount: 30, framesPerSecond: 60, gravity: [0, -9.81, 0] });
  const flat = Array.from(frames.frames ?? frames);
  return Array.from({ length: 30 }, (unused, frame) => flat[frame * POSITIONS.length + 1]);
}

test('a drag field at the strongest accepted strength keeps cloth finite and never lifts it', () => {
  const heights = fallHeights(1000);
  assert.ok(heights.every(Number.isFinite), 'heights stay finite');
  assert.ok(heights.every(height => height <= 1e-6), `a drag field must not push the sheet up; highest ${Math.max(...heights)}`);
});

test('a drag field never lets cloth rise against gravity at any accepted strength', () => {
  for (const strength of [300, 500, 1000]) {
    const heights = fallHeights(strength);
    assert.ok(heights.every(height => height <= 1e-6), `strength ${strength}: highest ${Math.max(...heights)}`);
  }
});

test('a gentle drag still slows the fall in proportion', () => {
  const free = fallHeights(0)[29];
  const dragged = fallHeights(10)[29];
  assert.ok(dragged > free && dragged < 0, `free ${free}, dragged ${dragged}`);
});
