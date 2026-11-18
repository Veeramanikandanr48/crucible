import assert from 'node:assert/strict';
import test from 'node:test';
import { createGaussianSplats, createGaussianSplatsAsync } from '../src/gaussian-splats.js';

function buildSplatData(count) {
  const rotations = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) rotations[index * 4] = 1;
  return {
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    scales: new Float32Array(count * 3).fill(0.1),
    rotations,
    bounds: { minimum: [0, 0, 0], maximum: [1, 1, 1] },
  };
}

const BUILDERS = [
  ['createGaussianSplats', (data, options) => createGaussianSplats(data, options)],
  ['createGaussianSplatsAsync', (data, options) => createGaussianSplatsAsync(data, options)],
];

async function expectRejected(build, data, options, expectedError) {
  let failure = null;
  try {
    await build(data, options);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'expected the call to throw');
  assert.match(failure.message, expectedError);
  assert.doesNotMatch(failure.message, /Cannot read properties/);
  return failure;
}

for (const [name, build] of BUILDERS) {
  test(`${name} accepts well-formed hand-built data`, async () => {
    const splats = await build(buildSplatData(4));
    assert.equal(splats.count, 4);
  });

  test(`${name} names the array, its expected length and the length it got when an array is short`, async () => {
    const lengths = { positions: 3, scales: 3, rotations: 4, colors: 4 };
    for (const [field, shortLength] of Object.entries(lengths)) {
      const data = buildSplatData(2);
      data[field] = field === 'colors' ? new Uint8Array(shortLength) : new Float32Array(shortLength);
      const stride = field === 'positions' || field === 'scales' ? 3 : 4;
      const error = await expectRejected(build, data, undefined, new RegExp(`data\\.${field} to hold ${2 * stride} values.*got ${shortLength}`));
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /Pass .* or lower data\.count to 1/);
    }
  });

  test(`${name} says which array is missing instead of an opaque TypeError`, async () => {
    for (const field of ['positions', 'scales', 'rotations', 'colors']) {
      const error = await expectRejected(build, { ...buildSplatData(2), [field]: undefined }, undefined, new RegExp(`data\\.${field} as a .*Array of`));
      assert.ok(error instanceof TypeError);
    }
    await expectRejected(build, { ...buildSplatData(2), positions: [0, 0, 0, 0, 0, 0] }, undefined, /data\.positions as a Float32Array or Float64Array/);
    await expectRejected(build, { ...buildSplatData(2), colors: new Float32Array(8) }, undefined, /data\.colors as a Uint8Array or Uint8ClampedArray/);
  });

  test(`${name} refuses a fractional or infinite count`, async () => {
    await expectRejected(build, { ...buildSplatData(3), count: 2.5 }, undefined, /data\.count to be a whole number of splats, got 2\.5/);
    await expectRejected(build, { ...buildSplatData(3), count: Number.POSITIVE_INFINITY }, undefined, /whole number/);
  });

  test(`${name} refuses colors that do not start on a 4-byte boundary`, async () => {
    const shifted = new Uint8Array(new ArrayBuffer(16), 1, 8);
    await expectRejected(build, { ...buildSplatData(2), colors: shifted }, undefined, /4-byte boundary.*colors\.slice\(\)/);
  });

  test(`${name} explains a null matrix and null options and keeps undefined as the default`, async () => {
    const data = buildSplatData(2);
    await expectRejected(build, data, { matrix: null }, /matrix must be 16 finite numbers.*left out for identity, got null/);
    await expectRejected(build, data, { matrix: 'flat' }, /matrix must be 16 finite numbers.*got string/);
    await expectRejected(build, data, null, /options must be an object.*or left out, got null/);
    await expectRejected(build, data, 'fast', /options must be an object.*got string/);
    assert.equal((await build(data, { matrix: undefined })).count, 2);
    assert.equal((await build(data, undefined)).count, 2);
  });

  test(`${name} accepts longer arrays and Float64 positions, using the first count splats`, async () => {
    const data = buildSplatData(2);
    const longer = { ...data, positions: new Float64Array(30).fill(1), colors: new Uint8Array(40) };
    assert.equal((await build(longer)).count, 2);
  });
}
