import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchNativeExport } from '../scripts/agent-native-trace.mjs';
import {
  NATIVE_CHUNKED_DEFAULT_TRIANGLES, NATIVE_CHUNKED_MAXIMUM_TRIANGLES, NATIVE_JOB_MAXIMUM_TRIANGLES, chunkedTriangleBound, exportNativeSceneTables,
} from '../scripts/native-bake-page.js';
import { MAX_NATIVE_TRACE_TRIANGLES } from '../src/path-tracer-scene.js';

// A DevTools session that fails the test if the host reads a table through it.
const NO_SESSION = { send: async method => { throw new Error(`unexpected DevTools call ${method}`); } };

test('the chunked triangle bound follows the adapter limit between the job bound and the ceiling', () => {
  assert.equal(chunkedTriangleBound(4_793_490), 4_793_490);
  assert.equal(chunkedTriangleBound(9_999_999.7), 9_999_999);
  assert.equal(chunkedTriangleBound(40_000_000), NATIVE_CHUNKED_MAXIMUM_TRIANGLES);
  assert.equal(chunkedTriangleBound(100_000), NATIVE_JOB_MAXIMUM_TRIANGLES, 'a small card still gets the exact capacity message, not a page refusal');
});

test('without a usable adapter limit the chunked bound is the default', () => {
  for (const unknown of [undefined, null, Number.NaN, Infinity, 0, -3, '4000000']) {
    assert.equal(chunkedTriangleBound(unknown), NATIVE_CHUNKED_DEFAULT_TRIANGLES, `value ${String(unknown)}`);
  }
});

test('the ceiling of a chunked export is the one buildTraceScene accepts', () => {
  assert.equal(NATIVE_CHUNKED_MAXIMUM_TRIANGLES, MAX_NATIVE_TRACE_TRIANGLES);
});

test('an export refuses a triangle bound outside 1 to the ceiling, naming the range', () => {
  for (const value of [0, -1, 1.5, NATIVE_CHUNKED_MAXIMUM_TRIANGLES + 1, '5']) {
    assert.throws(() => exportNativeSceneTables({ transport: 'chunks', maximumTriangles: value, modules: {} }),
      { name: 'RangeError', message: new RegExp(`maximumTriangles must be an integer from 1 to ${NATIVE_CHUNKED_MAXIMUM_TRIANGLES}`) }, `value ${String(value)}`);
  }
});

test('the host asks the page to pack with the bound its adapter allows, and with the default when it reports none', async () => {
  const requests = [];
  const page = {
    async evaluate(callback, request) {
      requests.push(request);
      return { chunks: { tables: {}, chunkBytes: 3 }, schemaVersion: 2, counts: { triangleCount: 10 } };
    },
  };
  await fetchNativeExport(page, { sessionId: 's', options: {} }, { capacity: { maxUniqueTriangles: 6_500_000 }, session: NO_SESSION });
  await fetchNativeExport(page, { sessionId: 's', options: {} }, { session: NO_SESSION });
  const exportRequests = requests.filter(request => request?.chunked);
  assert.deepEqual(exportRequests.map(request => request.maximumTriangles), [6_500_000, NATIVE_CHUNKED_DEFAULT_TRIANGLES]);
});

test('a scene over what the adapter holds fails before any table is read, naming the count, the limit and the overage', async () => {
  const session = { send: async () => { tablesRead += 1; return {}; } };
  let tablesRead = 0;
  const page = {
    async evaluate(callback, request) {
      
      return { chunks: { tables: { triangles: 8 }, chunkBytes: 8 }, schemaVersion: 2, counts: { triangleCount: 5_000_000, instanceCount: 1 } };
    },
  };
  const capacity = { adapter: 'Test GPU', maxUniqueTriangles: 4_793_490, maxInstances: 6_710_886, maxTextureTexels: 268_435_456 };
  await assert.rejects(fetchNativeExport(page, { sessionId: 's', options: {} }, { capacity, session }),
    error => error.nativeCapacity === true && /5,000,000 unique triangles.*over the 4,793,490 \(maxUniqueTriangles\).*Test GPU.*206,510 too many.*decimate/s.test(error.message));
  assert.equal(tablesRead, 0);
});
