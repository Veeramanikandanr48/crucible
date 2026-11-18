import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alphaOver, applyMatteAsAlpha, cryptomatteByte, cryptomatteMatte, depthMetresFromPass, floatPassToBytes, matteToGrayRgba, objectIdMatte, zCombine,
} from '../src/pass-compositing.js';
import { cryptomatteValue } from '../src/render-passes.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactNames, createAgentRenderJobs, normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { encodeMattePng, renderJobMattes } from '../scripts/job-mattes.mjs';
import { inflateSync } from 'node:zlib';

const rgba = (...pixels) => Uint8Array.from(pixels.flat());

test('zCombine keeps the nearer pixel, the first input on a tie, and never a background pixel', () => {
  const colorA = rgba([255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255]);
  const colorB = rgba([0, 0, 255, 255], [0, 0, 255, 255], [0, 0, 255, 255], [0, 0, 255, 255]);
  const depthA = Float32Array.from([2, 2, 5, Infinity]);
  const depthB = Float32Array.from([3, 2, 1, Infinity]);
  const result = zCombine({ width: 2, height: 2, colorA, depthA, colorB, depthB });
  assert.deepEqual([...result.nearest], [0, 0, 1, 0]);
  assert.deepEqual([...result.depth], [2, 2, 1, Infinity]);
  assert.deepEqual([...result.color], [255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
});

test('depthMetresFromPass reads the 16-bit step over the range and sends the background to Infinity', () => {
  const pixels = rgba([0, 0, 0, 255], [128, 0, 0, 255], [255, 255, 0, 255], [0, 1, 0, 255]);
  const metres = depthMetresFromPass({ pixels, width: 2, height: 2 });
  assert.equal(metres[0], 0);
  assert.equal(metres[1], Math.fround(32768 / 65535 * 100));
  assert.equal(metres[2], Infinity);
  assert.equal(metres[3], Math.fround(1 / 65535 * 100));
  assert.equal(depthMetresFromPass({ pixels, width: 2, height: 2, depthRange: 10 })[1], Math.fround(32768 / 65535 * 10));
});

test('alphaOver composites straight-alpha pixels byte for byte', () => {
  const foreground = rgba([255, 0, 0, 128], [10, 20, 30, 0], [200, 100, 50, 255], [90, 90, 90, 0]);
  const background = rgba([0, 0, 255, 255], [1, 2, 3, 255], [9, 9, 9, 9], [5, 5, 5, 0]);
  const result = alphaOver({ width: 2, height: 2, foreground, background });
  assert.deepEqual([...result], [128, 0, 127, 255, 1, 2, 3, 255, 200, 100, 50, 255, 0, 0, 0, 0]);
  // A half-transparent foreground over a transparent background keeps its own colour and alpha.
  const onNothing = alphaOver({ width: 1, height: 1, foreground: rgba([255, 0, 0, 128]), background: rgba([0, 0, 0, 0]) });
  assert.deepEqual([...onNothing], [255, 0, 0, 128]);
  // Over with itself is repeatable: same bytes on every call.
  assert.deepEqual([...alphaOver({ width: 2, height: 2, foreground, background })], [...result]);
});

test('floatPassToBytes flips the bottom-first readback and rounds to bytes', () => {
  const readback = Float32Array.from([
    0, 0, 1, 1, 1, 1, 1, 1, // bottom row
    1, 0, 0, 1, 0.5, 0.5, 0.5, 1, // top row
  ]);
  assert.deepEqual([...floatPassToBytes({ pixels: readback, width: 2, height: 2 })],
    [255, 0, 0, 255, 128, 128, 128, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
});

test('objectIdMatte selects 24-bit IDs and rejects an empty or invalid list', () => {
  const pixels = rgba([1, 0, 0, 255], [2, 0, 0, 255], [0, 1, 0, 255], [0, 0, 0, 255]);
  assert.deepEqual([...objectIdMatte({ pixels, width: 2, height: 2, ids: [2, 256] })], [0, 255, 255, 0]);
  assert.throws(() => objectIdMatte({ pixels, width: 2, height: 2, ids: [] }), /object IDs from 1/);
  assert.throws(() => objectIdMatte({ pixels, width: 2, height: 2, ids: [0] }), /object IDs from 1/);
});

test('cryptomatteMatte matches the hash byte of one channel and never the background', () => {
  const heroByte = cryptomatteByte(cryptomatteValue(1));
  const stoneByte = cryptomatteByte(cryptomatteValue(2));
  assert.notEqual(heroByte, stoneByte);
  const pixels = rgba([heroByte, stoneByte, 255, 255], [stoneByte, heroByte, 255, 255], [heroByte, heroByte, 0, 255], [0, 0, 0, 255]);
  assert.deepEqual([...cryptomatteMatte({ pixels, width: 2, height: 2, channel: 'object', value: cryptomatteValue(1) })], [255, 0, 0, 0]);
  assert.deepEqual([...cryptomatteMatte({ pixels, width: 2, height: 2, channel: 'material', value: cryptomatteValue(1) })], [0, 255, 0, 0]);
  assert.throws(() => cryptomatteMatte({ pixels, width: 2, height: 2, channel: 'both', value: 0.5 }), /'object' or 'material'/);
  assert.throws(() => cryptomatteMatte({ pixels, width: 2, height: 2, channel: 'object', value: 2 }), /metrics.cryptomatte/);
});

test('a matte turns a colour buffer into an alpha-over cut-out', () => {
  const color = rgba([10, 20, 30, 255], [40, 50, 60, 255]);
  const mask = Uint8Array.from([255, 0]);
  const cutout = applyMatteAsAlpha({ width: 2, height: 1, color, mask });
  assert.deepEqual([...cutout], [10, 20, 30, 255, 40, 50, 60, 0]);
  assert.deepEqual([...matteToGrayRgba(mask)], [255, 255, 255, 255, 0, 0, 0, 255]);
});

test('compositing rejects mismatched sizes with what to pass instead', () => {
  const small = new Uint8Array(4);
  assert.throws(() => alphaOver({ width: 2, height: 2, foreground: small, background: small }), /needs 16 \(width x height x 4\)/);
  assert.throws(() => alphaOver({ width: 0, height: 2, foreground: small, background: small }), /frame size/);
  assert.throws(() => alphaOver({ width: 4000, height: 4000, foreground: small, background: small }), /3840x2160/);
  assert.throws(() => alphaOver({ width: 1, height: 1, foreground: [1, 2, 3, 4], background: small }), /Uint8Array/);
  assert.throws(() => zCombine({ width: 1, height: 1, colorA: small, colorB: small, depthA: Float32Array.of(NaN), depthB: Float32Array.of(1) }), /NaN.*Infinity/);
  assert.throws(() => zCombine({ width: 1, height: 1, colorA: small, colorB: small, depthA: Float32Array.of(1, 2), depthB: Float32Array.of(1) }), /same size/);
});

test('renderJobMattes builds one PNG per matte from the object and cryptomatte passes', async () => {
  const heroValue = cryptomatteValue(1);
  const stoneValue = cryptomatteValue(2);
  const cryptomatte = { objects: { hero: { id: 1, value: heroValue }, floor: { id: 2, value: stoneValue } },
    materials: { steel: { id: 1, value: heroValue }, stone: { id: 2, value: stoneValue } } };
  // Bottom row first: the top row of the picture is [hero, floor], the bottom row [floor, background].
  const objectIds = Float32Array.from([2 / 255, 0, 0, 1, 0, 0, 0, 1, 1 / 255, 0, 0, 1, 2 / 255, 0, 0, 1]);
  const crypto = Float32Array.from([stoneValue, stoneValue, 1, 1, 0, 0, 0, 1, heroValue, heroValue, 1, 1, stoneValue, stoneValue, 1, 1]);
  const seen = [];
  const renderPass = async name => {
    seen.push(name);
    return name === 'objectId'
      ? { info: { objectNames: ['hero', 'floor'] }, pixels: objectIds, width: 2, height: 2 }
      : { info: { cryptomatte }, pixels: crypto, width: 2, height: 2 };
  };
  const results = await renderJobMattes({ mattes: [{ object: 'hero' }, { object: 'floor' }, { material: 'stone' }], renderPass });
  assert.deepEqual(seen, ['objectId', 'cryptomatte'], 'each pass renders once');
  assert.deepEqual([...results[0].bytes], [...encodeMattePng(Uint8Array.from([255, 0, 0, 0]), 2, 2)]);
  assert.deepEqual([...results[1].bytes], [...encodeMattePng(Uint8Array.from([0, 255, 255, 0]), 2, 2)]);
  assert.deepEqual([...results[2].bytes], [...encodeMattePng(Uint8Array.from([0, 255, 255, 0]), 2, 2)]);
  assert.deepEqual(results.map(result => result.metric.coveragePixels), [1, 2, 2]);
  assert.deepEqual(results[0].metric.partIds, [1]);
  await assert.rejects(renderJobMattes({ mattes: [{ object: 'chair' }], renderPass }), /no part named "chair".*hero, floor/);
  await assert.rejects(renderJobMattes({ mattes: [{ material: 'glass' }], renderPass }), /no material named "glass".*steel, stone/);
});

test('encodeMattePng writes an 8-bit gray PNG whose rows are the mask', () => {
  const png = encodeMattePng(Uint8Array.from([255, 0, 0, 255, 255, 0]), 3, 2);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 3);
  assert.equal(png.readUInt32BE(20), 2);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 0, 'gray colour type');
  const dataLength = png.readUInt32BE(33);
  const rows = inflateSync(png.subarray(41, 41 + dataLength));
  assert.deepEqual([...rows], [0, 255, 0, 0, 0, 255, 255, 0]);
  assert.throws(() => encodeMattePng(Uint8Array.from([1, 2]), 3, 2), /one byte per pixel/);
});

test('settings.mattes is validated and adds one file per matte and frame', () => {
  const recipe = { format: 'fixture' };
  const base = { kind: 'image', width: 64, height: 64 };
  const settings = normalizeJobSettings({ ...base, passes: ['depth'], mattes: [{ object: 'hero' }, { material: 'stone' }] }, [], recipe);
  assert.deepEqual(settings.mattes, [{ object: 'hero' }, { material: 'stone' }]);
  assert.deepEqual(artifactNames('image', ['depth'], 'png', false, 8, settings.mattes), ['render.png', 'render-depth.png', 'render-matte-0.png', 'render-matte-1.png']);
  assert.deepEqual(artifactNames('stills', [], 'png', false, 2, [{ object: 'a' }]), ['frame-0.png', 'frame-0-matte-0.png', 'frame-1.png', 'frame-1-matte-0.png']);
  assert.deepEqual(artifactNames('image', ['depth']), ['render.png', 'render-depth.png']);
  const rejected = (mattes, extra, pattern) => assert.throws(() => normalizeJobSettings({ ...base, ...extra, mattes }, [], recipe), pattern);
  rejected([], {}, /1 to 8 entries/);
  rejected(Array.from({ length: 9 }, () => ({ object: 'a' })), {}, /1 to 8 entries/);
  rejected([{}], {}, /exactly one of object or material/);
  rejected([{ object: 'a', material: 'b' }], {}, /exactly one of object or material/);
  rejected([{ object: '' }], {}, /1 to 120 characters/);
  rejected([{ object: 'a'.repeat(121) }], {}, /1 to 120 characters/);
  rejected([{ part: 'a' }], {}, /Unknown mattes\[0\] field: part/);
  rejected([{ object: 'a' }], { kind: 'video', fps: 24, duration: 1 }, /image or stills/);
  rejected([{ object: 'a' }], { format: 'exr' }, /8-bit PNG/);
  rejected([{ object: 'a' }], { renderer: { type: 'pathTracer' } }, /cannot combine with renderer/);
});

test('a job with mattes publishes every matte file through the job store', async context => {
  const root = await mkdtemp(join(tmpdir(), 'crucible-mattes-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const run = async ({ directory, settings }) => {
    const artifacts = [];
    for (const filename of artifactNames(settings.kind, settings.passes, settings.format, settings.multilayer, settings.frameCount, settings.mattes)) {
      await writeFile(join(directory, `${filename}.partial`), Buffer.from(filename));
      artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: 'image/png' });
    }
    return { artifacts, metrics: {} };
  };
  const limits = { maxOutputBytes: 1024 ** 2, maxFrameBytes: 128, maxStoreBytes: 8 * 1024 ** 2, cleanupMs: 100 };
  const controller = await createAgentRenderJobs({ root, limits, run });
  const submitted = await controller.submit({ sourceRevision: 0, snapshot: { recipe: { format: 'fixture' } },
    settings: { kind: 'stills', width: 64, height: 64, stillCount: 2, mattes: [{ object: 'a' }, { material: 'b' }] } });
  while (controller.status(submitted.jobId).state !== 'completed') await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(controller.status(submitted.jobId).artifacts.map(artifact => artifact.filename),
    ['frame-0.png', 'frame-0-matte-0.png', 'frame-0-matte-1.png', 'frame-1.png', 'frame-1-matte-0.png', 'frame-1-matte-1.png']);
  await controller.release(submitted.jobId);
  await controller.close();
});
