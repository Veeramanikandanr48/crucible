import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bakeGasSim } from '../src/gas-sim.js';
import { encodeVolumeGrid } from '../src/volume-grid.js';
import { EXPLOSION_BAKE_VERSION, EXPLOSION_GRID_FRAMES, explosionGridBytes, setExplosionBakeStore } from '../src/explosion-grids.js';
import { bakeCacheDirectory, createExplosionBakeCache, decodeBake } from '../src/explosion-bake-cache.js';

// One entry per solver version: the SHA-256 of a small bake. A change to gas-sim.js that changes its output fails the first test until
// EXPLOSION_BAKE_VERSION goes up and the new hash is added here, so a cache file of the old solver is never served for the new one.
const SOLVER_OUTPUT_HASHES = { 1: 'bd010eb2746e64c5d204792be3c6ee60ae9075f7f641bcbaf615c1dd7d6ff438' };

function makeFolder() {
  return mkdtempSync(join(tmpdir(), 'crucible-bake-cache-'));
}

function descriptorFor(seed) {
  return { version: EXPLOSION_BAKE_VERSION, fuel: 'dry', seed, velocity: false, frames: 3, parameters: ['test'] };
}

function sampleFrames() {
  return [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
}

test('the solver version constant matches the output of the gas solver', () => {
  const baked = bakeGasSim({ resolution: 10, cellSize: 0.8, frames: 4, fps: 24, seed: 7, maxSeconds: 30, velocity: true, turbulence: 1, vorticity: 40 });
  const hash = createHash('sha256');
  for (const frame of baked.frames) hash.update(encodeVolumeGrid({ resolution: baked.resolution, channels: frame, size: [8, 8, 8] }));
  assert.equal(hash.digest('hex'), SOLVER_OUTPUT_HASHES[EXPLOSION_BAKE_VERSION],
    `gas-sim.js output changed: raise EXPLOSION_BAKE_VERSION in src/explosion-grids.js (now ${EXPLOSION_BAKE_VERSION}) and add the new hash for it to SOLVER_OUTPUT_HASHES.`);
});

test('a saved bake loads back byte for byte', () => {
  const folder = makeFolder();
  try {
    const cache = createExplosionBakeCache(folder);
    cache.save(descriptorFor(1), sampleFrames());
    assert.deepEqual(cache.load(descriptorFor(1)), sampleFrames());
    assert.equal(cache.load(descriptorFor(2)), null);
    assert.equal(cache.load({ ...descriptorFor(1), version: EXPLOSION_BAKE_VERSION + 1 }), null);
    assert.equal(cache.load({ ...descriptorFor(1), parameters: ['other'] }), null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a corrupt or truncated cache file is ignored', () => {
  const folder = makeFolder();
  try {
    const cache = createExplosionBakeCache(folder);
    cache.save(descriptorFor(1), sampleFrames());
    const [name] = readdirSync(folder);
    const path = join(folder, name);
    const original = readFileSync(path);
    const flipped = Buffer.from(original);
    flipped[flipped.length - 1] ^= 0xff;
    writeFileSync(path, flipped);
    assert.equal(cache.load(descriptorFor(1)), null, 'a flipped byte fails the checksum');
    writeFileSync(path, original);
    truncateSync(path, original.length - 1);
    assert.equal(cache.load(descriptorFor(1)), null, 'a truncated file is refused');
    writeFileSync(path, Buffer.from('not a bake'));
    assert.equal(cache.load(descriptorFor(1)), null, 'a foreign file is refused');
    assert.equal(decodeBake(original, 2), null, 'a frame count that differs from the bake is refused');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the folder stays under its size cap by dropping the oldest bake', () => {
  const folder = makeFolder();
  try {
    const cache = createExplosionBakeCache(folder, { maxBytes: 200 });
    const frames = [new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)];
    for (const seed of [1, 2, 3]) cache.save(descriptorFor(seed), frames);
    assert.equal(cache.load(descriptorFor(3))?.length, 3, 'the newest bake is kept');
    assert.ok(readdirSync(folder).length < 3, 'older bakes were dropped');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('add-explosion frames come from the store when it has them', () => {
  const stored = Array.from({ length: EXPLOSION_GRID_FRAMES }, (_, index) => new Uint8Array([index]));
  let loads = 0;
  setExplosionBakeStore({ load: () => { loads += 1; return stored; }, save: () => assert.fail('a hit must not be saved again') });
  try {
    assert.equal(explosionGridBytes('explosion-dry-910001_0005.67vg')[0], 5);
    assert.equal(explosionGridBytes('explosion-dry-910001_0006.67vg')[0], 6);
    assert.equal(loads, 1, 'the second frame comes from memory');
  } finally {
    setExplosionBakeStore(null);
  }
});

test('a fresh bake is saved and a later load equals it byte for byte', () => {
  const folder = makeFolder();
  try {
    setExplosionBakeStore(createExplosionBakeCache(folder));
    const fresh = explosionGridBytes('explosion-dry-910002_0000.67vg');
    setExplosionBakeStore(null);
    const [name] = readdirSync(folder);
    const reloaded = decodeBake(readFileSync(join(folder, name)), EXPLOSION_GRID_FRAMES);
    assert.deepEqual(Buffer.from(reloaded[0]), Buffer.from(fresh));
  } finally {
    setExplosionBakeStore(null);
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the cache folder comes from the environment, the user cache or off', () => {
  assert.equal(bakeCacheDirectory({ CRUCIBLE_BAKE_CACHE: 'off' }), null);
  assert.equal(bakeCacheDirectory({ CRUCIBLE_BAKE_CACHE: join(tmpdir(), 'x') }), join(tmpdir(), 'x'));
  assert.throws(() => bakeCacheDirectory({ CRUCIBLE_BAKE_CACHE: 'relative' }), /absolute folder or "off"/);
  assert.equal(bakeCacheDirectory({ XDG_CACHE_HOME: join(tmpdir(), 'c') }, 'linux'), join(tmpdir(), 'c', 'crucible', 'explosion-bakes'));
});
