import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { collectExportBlob, createNativeTracerLocator, fetchNativeExport } from '../scripts/agent-native-trace.mjs';
import {
  DELTA_GAP_BYTES, DELTA_MAXIMUM_RANGES, applyExportDelta, changedRanges, deltaByteLength, deltaPieces, planExportDelta,
} from '../scripts/native-export-delta.js';
import { cookInstalled } from './support/cook.js';

function patternBytes(length, seed) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + seed) & 255;
  return bytes;
}

function withChanges(bytes, changes) {
  const copy = bytes.slice();
  for (const [offset, value] of changes) copy[offset] = value;
  return copy;
}

const concatenate = pieces => Uint8Array.from(pieces.flatMap(piece => [...piece]));

test('changedRanges lists where two tables differ and merges changes closer than the gap', () => {
  const before = patternBytes(40000, 1);
  const after = withChanges(before, [[100, 7], [101, 9], [100 + DELTA_GAP_BYTES, 3], [20000, 1], [39999, 5]]);
  assert.deepEqual(changedRanges(before, before), []);
  const ranges = changedRanges(before, after);
  assert.equal(ranges.length, 3);
  assert.equal(ranges[0][0], 100 - (100 % 4));
  assert.ok(ranges[0][0] + ranges[0][1] > 100 + DELTA_GAP_BYTES, 'two changes within the gap are one range');
  assert.ok(ranges[2][0] + ranges[2][1] === 40000, 'a change in the last byte is covered');
});

test('changedRanges reads a table that starts off a word boundary and has a tail shorter than a word', () => {
  const backing = patternBytes(1003, 4);
  const before = backing.subarray(1, 1002);
  const after = withChanges(before, [[3, 1], [1000, 8]]);
  const ranges = changedRanges(before, after);
  assert.deepEqual(ranges.map(([offset, length]) => [offset <= 3 && offset + length > 3, offset <= 1000 && offset + length > 1000]).flat().filter(Boolean).length, 2);
});

test('changedRanges gives up with null past the range cap, so the table goes whole', () => {
  const before = new Uint8Array((DELTA_MAXIMUM_RANGES + 5) * (DELTA_GAP_BYTES + 8));
  const after = before.slice();
  for (let index = 0; index < DELTA_MAXIMUM_RANGES + 5; index++) after[index * (DELTA_GAP_BYTES + 8)] = 1;
  assert.equal(changedRanges(before, after), null);
  assert.deepEqual(planExportDelta({ triangles: before }, { triangles: after }), { triangles: [[0, after.byteLength]] });
});

test('a delta rebuilds the same tables a full export gives, and leaves the previous ones alone', () => {
  const previous = { triangles: patternBytes(30000, 1), materials: patternBytes(512, 2), lights: patternBytes(128, 3), environment: patternBytes(900, 4) };
  const tables = {
    triangles: withChanges(previous.triangles, [[29990, 1], [29991, 2], [5000, 9]]),
    materials: previous.materials.slice(),
    lights: patternBytes(130, 3),
    environment: withChanges(previous.environment, [[0, 1]]),
  };
  const frozenPrevious = structuredClone(previous);
  const ranges = planExportDelta(previous, tables);
  assert.deepEqual(ranges.materials, []);
  assert.deepEqual(ranges.lights, [[0, 130]], 'a table of another length goes whole');
  assert.ok(deltaByteLength(ranges) < 3000, `only the changes cross, not ${deltaByteLength(ranges)} bytes`);
  const sent = concatenate(deltaPieces(tables, ranges));
  assert.equal(sent.byteLength, deltaByteLength(ranges));
  const lengths = Object.fromEntries(Object.entries(tables).map(([name, bytes]) => [name, bytes.byteLength]));
  const rebuilt = applyExportDelta({ previous, lengths, ranges, sent });
  assert.deepEqual(rebuilt, tables);
  assert.equal(rebuilt.materials, previous.materials, 'an unchanged table is the object that is already held');
  assert.notEqual(rebuilt.triangles.buffer, previous.triangles.buffer, 'a changed table is a new buffer, since a native session may still hold the old one');
  assert.deepEqual(previous, frozenPrevious);
});

test('applyExportDelta refuses ranges outside a table, a short blob and a table it does not hold', () => {
  const previous = { triangles: patternBytes(16, 1) };
  const lengths = { triangles: 16 };
  assert.throws(() => applyExportDelta({ previous, lengths, ranges: { triangles: [[12, 8]] }, sent: new Uint8Array(8) }), /outside its 16 bytes/);
  assert.throws(() => applyExportDelta({ previous, lengths, ranges: { triangles: [[0, 4], [2, 4]] }, sent: new Uint8Array(8) }), /out of order/);
  assert.throws(() => applyExportDelta({ previous, lengths, ranges: { triangles: [[0, 4]] }, sent: new Uint8Array(3) }), /sent 3 bytes|hold/);
  assert.throws(() => applyExportDelta({ previous: {}, lengths, ranges: { triangles: [[0, 4]] }, sent: new Uint8Array(4) }), /no bytes for it/);
  assert.throws(() => applyExportDelta({ previous, lengths, ranges: {}, sent: new Uint8Array(0) }), /no ranges for table "triangles"/);
});

function deltaManifest(previous, tables, base) {
  const ranges = planExportDelta(previous, tables);
  const lengths = Object.fromEntries(Object.entries(tables).map(([name, bytes]) => [name, bytes.byteLength]));
  return { manifest: { schemaVersion: 2, counts: {}, exportId: 'export-2', chunks: { tables: lengths, chunkBytes: 16, delta: { base, ranges } } }, sent: concatenate(deltaPieces(tables, ranges)) };
}

test('collectExportBlob reads a delta against its baseline and says how many bytes crossed', async () => {
  const previous = { triangles: patternBytes(20000, 1), materials: patternBytes(64, 2) };
  const tables = { triangles: withChanges(previous.triangles, [[19000, 4]]), materials: previous.materials.slice() };
  const { manifest, sent } = deltaManifest(previous, tables, 'export-1');
  const collected = await collectExportBlob(manifest, async byteLength => {
    assert.equal(byteLength, sent.byteLength);
    return sent;
  }, { baseline: { id: 'export-1', tables: previous } });
  assert.deepEqual(collected.tables, tables);
  assert.equal(collected.sentBytes, sent.byteLength);
  assert.ok(collected.sentBytes < 100);
  await assert.rejects(collectExportBlob(structuredClone(manifest), async () => sent, { baseline: { id: 'export-0', tables: previous } }), /delta against "export-1".*"export-0"/);
  await assert.rejects(collectExportBlob(structuredClone(manifest), async () => sent), /delta against "export-1"/);
});

// A page that answers exportNativeScene the way the real one does: a delta against the baseline id it is asked for, else whole.
function fakePage(frames) {
  const requests = [];
  let frameIndex = 0;
  let blob = null;
  return {
    requests,
    async evaluate(run, argument) {
      if (argument === undefined) return undefined;
      requests.push(argument);
      const tables = frames[frameIndex];
      const previousTables = frameIndex > 0 ? frames[frameIndex - 1] : null;
      const lengths = Object.fromEntries(Object.entries(tables).map(([name, bytes]) => [name, bytes.byteLength]));
      const chunks = { tables: lengths, chunkBytes: 16 };
      const baseId = frameIndex > 0 ? `export-${frameIndex}` : undefined;
      let pieces = Object.values(tables);
      if (argument.deltaBase !== undefined && argument.deltaBase === baseId) {
        const ranges = planExportDelta(previousTables, tables);
        chunks.delta = { base: baseId, ranges };
        pieces = deltaPieces(tables, ranges);
      }
      blob = concatenate(pieces);
      frameIndex += 1;
      return { schemaVersion: 2, counts: {}, chunks, ...(argument.keepBaseline ? { exportId: `export-${frameIndex}` } : {}) };
    },
    context: () => ({ newCDPSession: async () => { throw new Error('the test passes a session'); } }),
    blobBytes: () => blob,
  };
}

function sessionOver(page) {
  return {
    async send(method, parameters) {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'object-1' } };
      if (method === 'IO.resolveBlob') return { uuid: 'uuid' };
      if (method === 'IO.read') {
        const slice = page.blobBytes().subarray(parameters.offset, parameters.offset + parameters.size);
        return { base64Encoded: true, data: Buffer.from(slice).toString('base64'), eof: false };
      }
      return {};
    },
  };
}

test('fetchNativeExport keeps a baseline across frames and reads only what changed', async () => {
  const first = { triangles: patternBytes(50000, 1), materials: patternBytes(64, 2) };
  const second = { triangles: withChanges(first.triangles, [[49000, 3]]), materials: first.materials.slice() };
  const third = { triangles: withChanges(second.triangles, [[49004, 5]]), materials: first.materials.slice() };
  const page = fakePage([first, second, third]);
  const session = sessionOver(page);
  const baseline = {};
  const frameOne = await fetchNativeExport(page, { options: {} }, { session, baseline });
  assert.equal(frameOne.sentBytes, undefined, 'the first frame has no baseline and reads every table');
  assert.equal(baseline.id, 'export-1');
  const frameTwo = await fetchNativeExport(page, { options: {} }, { session, baseline });
  const frameThree = await fetchNativeExport(page, { options: {} }, { session, baseline });
  assert.deepEqual(frameTwo.tables, second);
  assert.deepEqual(frameThree.tables, third);
  assert.ok(frameTwo.sentBytes < 100 && frameThree.sentBytes < 100);
  assert.deepEqual(page.requests.map(request => [request.keepBaseline, request.deltaBase]), [[true, undefined], [true, 'export-1'], [true, 'export-2']]);
  assert.equal(baseline.id, 'export-3');
});

test('fetchNativeExport asks for no baseline when none is given or JS67_NATIVE_EXPORT_DELTA is off', async t => {
  const tables = { triangles: patternBytes(64, 1) };
  const withoutBaseline = fakePage([tables]);
  await fetchNativeExport(withoutBaseline, { options: {} }, { session: sessionOver(withoutBaseline) });
  assert.equal(withoutBaseline.requests[0].keepBaseline, undefined);
  process.env.JS67_NATIVE_EXPORT_DELTA = 'off';
  t.after(() => { delete process.env.JS67_NATIVE_EXPORT_DELTA; });
  const switchedOff = fakePage([tables, tables]);
  const baseline = { id: 'stale', tables };
  await fetchNativeExport(switchedOff, { options: {} }, { session: sessionOver(switchedOff), baseline });
  assert.equal(switchedOff.requests[0].keepBaseline, undefined);
  assert.equal(switchedOff.requests[0].deltaBase, undefined);
  assert.equal(baseline.id, undefined, 'a switched-off job holds no baseline');
});

// ---- A real clip, rendered with and without the delta (needs the built MCP server, Chrome and the native addon) ----

const serverEntry = new URL('../bin/crucible-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const hasBuild = existsSync(new URL('../build/mcp/server.mjs', import.meta.url));
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hasBrowser = existsSync(chromePath) || Boolean(process.env.CI);

function particleRecipe() {
  const nodes = [{ id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.1, -1], scale: [12, 0.2, 12] }];
  for (let index = 0; index < 4; index++) nodes.push({ id: `ball-${index}`, geometry: 'ball', material: 'stone', scale: [0.5, 0.5, 0.5], translation: [index * 1.6 - 2.4, 0.6, -1] });
  nodes.push({ id: 'dust', geometry: 'speck', material: 'ember' });
  return { format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'floor', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere', segments: 16 }, { id: 'speck', type: 'box', bevel: 0 }],
    materials: [{ id: 'stone', color: [0.6, 0.55, 0.5] }, { id: 'ember', color: [1, 0.6, 0.2] }], nodes,
    particles: { systems: [{ node: 'dust', seed: 1, count: 200, lifetime: 3, speed: 1, size: 0.03 }] },
    environment: { setup: 'sunset' }, camera: { eye: [0, 3, 6], target: [0, 0.5, -1], fov: 50 } };
}

async function renderClip(workDirectory, label, deltaSwitch) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, '--backend', 'cpu', '--memory', '768', '--jobs', join(workDirectory, `jobs-${label}`)],
    cwd: workDirectory,
    env: { ...process.env, JS67_NATIVE_EXPORT_DELTA: deltaSwitch },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'native-export-delta-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 600000 });
    const created = (await call('scene_create', { recipe: particleRecipe() })).structuredContent;
    const settings = { kind: 'video', width: 64, height: 64, fps: 6, duration: 4 / 6, motion: { start: 0 },
      renderer: { type: 'pathTracer', backend: 'native', samples: 2, bounces: 2, denoise: false, seed: 1, maxSeconds: 120 } };
    const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision, settings });
    assert.notEqual(submitted.isError, true, submitted.content?.[0]?.text);
    const { jobId } = submitted.structuredContent;
    let record;
    for (;;) {
      record = (await call('scene_render_status', { jobId })).structuredContent;
      if (['completed', 'cancelled', 'failed'].includes(record.state)) break;
      await delay(200);
    }
    assert.equal(record.state, 'completed', `the ${label} job ${record.state}: ${record.error ?? JSON.stringify(record)}`);
    const result = (await call('scene_render_result', { jobId, response_format: 'detailed' })).structuredContent;
    const videoPath = join(workDirectory, `${label}.mp4`);
    await copyFile(result.artifacts[0].path, videoPath);
    return { video: await readFile(videoPath), pathTracer: (result.metrics ?? record.metrics).pathTracer };
  } finally {
    await client.close();
  }
}

// Why this machine cannot trace on the native backend, or null when it can: no Cook, no built addon, an addon that does not load
// (the same look the job runner makes) or no Vulkan ray query adapter (the capacity read needs one).
async function nativeTracingUnavailable() {
  if (!cookInstalled) return 'Cook is not installed';
  const found = await createNativeTracerLocator().find();
  if (!found.tracer) return found.reason;
  try {
    if (typeof found.tracer.readAdapterCapacity === 'function') found.tracer.readAdapterCapacity();
  } catch (error) {
    return `no Vulkan ray query adapter (${error.message})`;
  }
  return null;
}

test('a native clip with moving particles is byte for byte the same video with the delta on and off',
  { skip: (!hasBuild && 'run npm run build:lib first') || (!hasBrowser && 'no Chrome'), timeout: 900000 }, async context => {
    const unavailable = await nativeTracingUnavailable();
    if (unavailable) {
      context.skip(`native tracing cannot run here: ${unavailable}`);
      return;
    }
    const workDirectory = await mkdtemp(join(tmpdir(), 'crucible-export-delta-'));
    context.after(() => rm(workDirectory, { recursive: true, force: true }));
    const full = await renderClip(workDirectory, 'full', 'off');
    const delta = await renderClip(workDirectory, 'delta', 'on');
    if (full.pathTracer.backend !== 'native') {
      context.skip(`this machine has no native tracer (${full.pathTracer.backendNote})`);
      return;
    }
    assert.equal(full.pathTracer.exportSentBytes, undefined, 'with the delta off every frame reads whole tables');
    assert.ok(delta.pathTracer.exportSentBytes < delta.pathTracer.inputBytes / 2, `the last frame sent ${delta.pathTracer.exportSentBytes} of ${delta.pathTracer.inputBytes} bytes`);
    assert.equal(createHash('sha256').update(delta.video).digest('hex'), createHash('sha256').update(full.video).digest('hex'));
  });
