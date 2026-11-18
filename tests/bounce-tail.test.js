import assert from 'node:assert/strict';
import test from 'node:test';
import { addBounceTail, BOUNCE_TAIL_RATIO_LIMIT } from '../src/light-bake.js';
import { normalizeAgentBake } from '../src/agent-bake.js';

test('the tail adds the geometric series the last two bounces point to', () => {
  const sum = [1, 1, 1];
  addBounceTail(sum, [[0.4, 0.4, 0.4], [0.2, 0.2, 0.2], [0.1, 0.1, 0.1]]);
  // ratio 0.5, so the rest is last * 0.5 / 0.5 = last
  for (const channel of sum) assert.ok(Math.abs(channel - 1.1) < 1e-12);
});

test('the tail keeps the colour of the last bounce and never runs away from a ratio above the limit', () => {
  const sum = [0, 0, 0];
  addBounceTail(sum, [[0.1, 0.1, 0.1], [1, 0.5, 0.25]]);
  const share = BOUNCE_TAIL_RATIO_LIMIT / (1 - BOUNCE_TAIL_RATIO_LIMIT);
  assert.ok(Math.abs(sum[0] - share) < 1e-12);
  assert.ok(Math.abs(sum[1] - 0.5 * share) < 1e-12);
  assert.ok(Math.abs(sum[2] - 0.25 * share) < 1e-12);
});

test('no tail without a second bounce or without light', () => {
  const single = [1, 1, 1];
  addBounceTail(single, [[1, 1, 1]]);
  assert.deepEqual(single, [1, 1, 1]);
  const dark = [1, 1, 1];
  addBounceTail(dark, [[0, 0, 0], [0.5, 0.5, 0.5]]);
  assert.deepEqual(dark, [1, 1, 1]);
});

test('bake.bounceTail needs the grid and is not stored when off', () => {
  assert.equal(normalizeAgentBake({ irradianceGrid: true, bounceTail: true }).bounceTail, true);
  assert.equal(Object.hasOwn(normalizeAgentBake({ irradianceGrid: true }), 'bounceTail'), false);
  assert.throws(() => normalizeAgentBake({ bounceTail: true }), /bake\.bounceTail/);
});
