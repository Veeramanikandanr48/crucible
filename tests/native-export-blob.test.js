import assert from 'node:assert/strict';
import test from 'node:test';

import { collectExportBlob, readHeldNativeExport } from '../scripts/agent-native-trace.mjs';
import { readBlobBytes } from '../scripts/cdp-blob-read.mjs';

const MEGABYTE = 1024 ** 2;

function patternBytes(length, seed) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + seed) & 255;
  return bytes;
}

// A DevTools session over bytes held in memory: records every call and can shorten a read.
function fakeSession(blobBytes, { shortenBy = 0, evaluateFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, parameters) {
      calls.push({ method, parameters });
      if (method === 'Runtime.evaluate') {
        return evaluateFails ? { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught' } } : { result: { objectId: 'object-1' } };
      }
      if (method === 'IO.resolveBlob') return { uuid: 'blob-uuid' };
      if (method === 'IO.read') {
        assert.equal(parameters.handle, 'blob:blob-uuid');
        const slice = blobBytes.subarray(parameters.offset, parameters.offset + parameters.size - shortenBy);
        return { base64Encoded: true, data: Buffer.from(slice).toString('base64'), eof: false };
      }
      return {};
    },
  };
}

test('readBlobBytes returns the bytes of a Blob in parallel slices, in order', async () => {
  const blobBytes = patternBytes(5 * MEGABYTE + 123, 7);
  const session = fakeSession(blobBytes);
  const bytes = await readBlobBytes(session, 'window.makeBlob()', blobBytes.length);
  assert.deepEqual(bytes, blobBytes);
  const reads = session.calls.filter(call => call.method === 'IO.read');
  assert.ok(reads.length > 1, 'a blob over the slice size is read in more than one slice');
  assert.ok(reads.every(call => call.parameters.offset >= 0 && call.parameters.size <= 32 * MEGABYTE));
});

test('readBlobBytes closes the stream and releases the object when a read comes back short', async () => {
  const blobBytes = patternBytes(2 * MEGABYTE, 1);
  const session = fakeSession(blobBytes, { shortenBy: 5 });
  await assert.rejects(readBlobBytes(session, 'window.makeBlob()', blobBytes.length), /sent \d+ bytes at offset \d+, expected \d+/);
  const methods = session.calls.map(call => call.method);
  assert.ok(methods.includes('IO.close'), 'the blob stream is closed after a failed read');
  assert.ok(methods.includes('Runtime.releaseObject'), 'the page object is released after a failed read');
});

test('readBlobBytes names the expression when it is not a Blob, and refuses a size it cannot allocate', async () => {
  await assert.rejects(readBlobBytes(fakeSession(new Uint8Array(4), { evaluateFails: true }), 'window.nothing()', 4), /did not evaluate to a Blob/);
  for (const byteLength of [-1, 1.5, 3 * 1024 ** 3, '4']) {
    await assert.rejects(readBlobBytes(fakeSession(new Uint8Array(4)), 'x', byteLength), { name: 'RangeError', message: /byteLength must be an integer from 0 to/ });
  }
  const session = fakeSession(new Uint8Array(0));
  assert.deepEqual(await readBlobBytes(session, 'x', 0), new Uint8Array(0));
  assert.equal(session.calls.length, 0, 'an empty export asks the browser for nothing');
});

test('collectExportBlob returns the tables that were held, byte for byte', async () => {
  const tables = { triangles: patternBytes(40, 3), materials: patternBytes(16, 9), atlas: patternBytes(8, 5) };
  const manifest = { schemaVersion: 2, counts: { triangleCount: 2 }, chunks: { tables: { triangles: 40, materials: 16, atlas: 8 }, chunkBytes: 16 } };
  const whole = Uint8Array.from(Object.values(tables).flatMap(bytes => [...bytes]));
  const viaBlob = await collectExportBlob(structuredClone(manifest), async byteLength => {
    assert.equal(byteLength, 64);
    return whole;
  });
  assert.deepEqual(viaBlob.tables, tables);
  assert.equal(viaBlob.chunks, undefined);
  assert.equal(viaBlob.counts.triangleCount, 2);
  for (const bytes of Object.values(viaBlob.tables)) assert.equal(bytes.byteOffset, 0, 'a table starts its own buffer, so any typed array can view it');
});

test('collectExportBlob refuses a blob of the wrong length and a manifest without chunks', async () => {
  const manifest = { chunks: { tables: { triangles: 8 }, chunkBytes: 8 } };
  await assert.rejects(collectExportBlob(manifest, async () => new Uint8Array(5)), /sent 5 bytes, expected 8/);
  await assert.rejects(collectExportBlob({ tables: {} }, async () => new Uint8Array(0)), /carries no `chunks` manifest/);
});

function fakePage(blobBytes) {
  const session = fakeSession(blobBytes);
  const page = {
    session,
    detached: false,
    released: 0,
    context: () => ({ newCDPSession: async () => Object.assign(session, { detach: async () => { page.detached = true; } }) }),
    evaluate: async release => { release(); },
  };
  return page;
}

test('readHeldNativeExport reads the held blob, releases the page copy and detaches the session it made', async () => {
  const tables = { triangles: patternBytes(40, 3), atlas: patternBytes(8, 5) };
  const manifest = { counts: { triangleCount: 2 }, chunks: { tables: { triangles: 40, atlas: 8 }, chunkBytes: 16 } };
  const page = fakePage(Uint8Array.from(Object.values(tables).flatMap(bytes => [...bytes])));
  const exported = await readHeldNativeExport(page, manifest, { blobExpression: 'window.held()', release: () => { page.released++; } });
  assert.deepEqual(exported.tables, tables);
  assert.equal(page.released, 1);
  assert.equal(page.detached, true);
  assert.equal(page.session.calls.find(call => call.method === 'Runtime.evaluate').parameters.expression, 'window.held()');
});

test('readHeldNativeExport still releases the page copy when the read fails, and keeps a session it was given', async () => {
  const manifest = { chunks: { tables: { triangles: 8 }, chunkBytes: 8 } };
  const page = fakePage(new Uint8Array(3));
  const givenSession = fakeSession(new Uint8Array(3));
  await assert.rejects(readHeldNativeExport(page, manifest, { blobExpression: 'window.held()', release: () => { page.released++; }, session: givenSession }), /sent \d+ bytes at offset \d+, expected \d+/);
  assert.equal(page.released, 1);
  assert.equal(page.detached, false, 'a session the caller made is the caller\'s to detach');
});

test('the bytes read from a real browser Blob equal what an evaluate returns as base64', async t => {
  let browser;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  } catch (error) {
    t.skip(`no Chrome to read a Blob from: ${error.message.split('\n')[0]}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const length = 3 * MEGABYTE + 77;
    await page.evaluate(size => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 11) & 255;
      window.held = bytes;
    }, length);
    const viaEvaluate = Buffer.from(await page.evaluate(() => {
      let binary = '';
      for (let offset = 0; offset < window.held.length; offset += 0x8000) binary += String.fromCharCode(...window.held.subarray(offset, offset + 0x8000));
      return btoa(binary);
    }), 'base64');
    const session = await page.context().newCDPSession(page);
    const viaBlob = await readBlobBytes(session, 'new Blob([window.held])', length);
    assert.equal(viaBlob.length, length);
    assert.ok(Buffer.from(viaBlob).equals(viaEvaluate), 'the Blob read is byte for byte the base64 read');
  } finally {
    await browser.close();
  }
});
