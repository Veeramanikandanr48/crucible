import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { findSequenceRuns } from '../scripts/agent-asset-sequences.mjs';
import { namesCatalogSequences, resolveCatalogSequenceNames } from '../src/agent-asset-names.js';
import { normalizeMapSequence } from '../src/agent-texture-sequence.js';

// A PNG header that declares a 2x2 size; the two salt bytes make every frame a different file.
function frameBytes(salt) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(2, 16);
  header.writeUInt32BE(2, 20);
  header[24] = 8;
  header.writeUInt16BE(salt, 29);
  return header;
}

async function folderWithFrames(context, count, { prefix = 'frame_', width = 4, start = 1, skipNumber = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-sequence-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (let offset = 0; offset < count; offset++) {
    const number = start + offset;
    if (number === skipNumber) continue;
    await writeFile(join(directory, `${prefix}${String(number).padStart(width, '0')}.png`), frameBytes(number));
  }
  return directory;
}

test('a long numbered folder is one sequence entry and its frames are hashed only when named (#1852)', async context => {
  const directory = await folderWithFrames(context, 300);
  await writeFile(join(directory, 'frame_0005.png'), Buffer.from('not an image at all, read only when the sequence is named'));
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.deepEqual(listing.assets, []);
  assert.deepEqual(listing.sequences, [{ kind: 'sequence', name: 'frame_####.png', first: 1, last: 300, frames: 300, width: 2, height: 2 }]);
  assert.ok(JSON.stringify(listing).length < 1024);
  await assert.rejects(catalog.resolveSequence('frame_####.png'), /frame_####\.png: frame frame_0005\.png: /);
});

test('resolveSequence returns the frame IDs in frame order and read() serves them (#1852)', async context => {
  const directory = await folderWithFrames(context, 300, { start: 0, width: 3 });
  const catalog = await createAgentAssetCatalog(directory);
  const sampleBytes = await readFile(join(directory, 'frame_150.png'));
  const sampleId = createHash('sha256').update(sampleBytes).digest('hex');
  assert.deepEqual(await catalog.read(sampleId), sampleBytes, 'a pinned frame ID from an earlier run is found before the sequence is named');
  const frameIds = await catalog.resolveSequence('frame_###.png');
  assert.equal(frameIds.length, 300);
  assert.equal(frameIds[150], sampleId);
  assert.equal(new Set(frameIds).size, 300);
  assert.equal(await catalog.size(frameIds[299]), (await readFile(join(directory, 'frame_299.png'))).length);
  assert.deepEqual(catalog.list().assets, [], 'frames hashed on demand do not join the listing');
});

test('a sequence name must match a listed pattern exactly and never reaches the file system (#1852)', async context => {
  const directory = await folderWithFrames(context, 300);
  const catalog = await createAgentAssetCatalog(directory);
  for (const pattern of ['../frame_####.png', 'frame_0001.png', 'frame_####.png/..', '', 7, undefined]) {
    await assert.rejects(catalog.resolveSequence(pattern), /map\.sequence\.catalog must be the pattern of a catalog sequence/);
  }
  await assert.rejects(catalog.resolveSequence('frame_###'), /Near patterns: "frame_####\.png"/);
});

test('folders of at most 256 frames, or with a gap in the numbers, keep one entry per image (#1852)', async context => {
  const shortDirectory = await folderWithFrames(context, 256);
  const shortListing = (await createAgentAssetCatalog(shortDirectory)).list();
  assert.equal(shortListing.sequences, undefined);
  assert.equal(shortListing.assets.length, 256);
  const gapDirectory = await folderWithFrames(context, 300, { skipNumber: 100 });
  const gapListing = (await createAgentAssetCatalog(gapDirectory)).list();
  assert.equal(gapListing.sequences, undefined);
  assert.equal(gapListing.assets.length, 299);
});

test('findSequenceRuns groups by prefix, digit width and extension (#1852)', () => {
  const names = [];
  for (let number = 1; number <= 300; number++) {
    names.push(`a_${String(number).padStart(3, '0')}.png`, `c_${number}.png`, `b_${String(number).padStart(3, '0')}.jpg`);
  }
  const runs = findSequenceRuns(names);
  assert.deepEqual(runs.map(run => run.pattern).sort(), ['a_###.png', 'b_###.jpg']);
  assert.equal(runs[0].names.length, 300);
});

test('map.sequence.catalog is swapped for the frame IDs, and both fields together are refused (#1852)', async () => {
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  const recipe = { materials: [{ id: 'screen', map: { sequence: { catalog: 'frame_####.png', fps: 24 } } }] };
  assert.equal(namesCatalogSequences(recipe), true);
  await resolveCatalogSequenceNames(recipe, async pattern => {
    assert.equal(pattern, 'frame_####.png');
    return ids;
  });
  assert.deepEqual(recipe.materials[0].map.sequence, { frames: ids, fps: 24 });
  assert.equal(namesCatalogSequences(recipe), false);
  const both = { materials: [{ id: 'screen', map: { sequence: { catalog: 'frame_####.png', frames: ids, fps: 24 } } }] };
  await assert.rejects(resolveCatalogSequenceNames(both, async () => ids), /exactly one of frames/);
});

test('a library caller that passes catalog without the host gets advice to pass frame IDs (#1852)', () => {
  assert.throws(() => normalizeMapSequence({ sequence: { catalog: 'frame_####.png', fps: 24 } }), /MCP server turns a catalog sequence name into its frame IDs/);
});
