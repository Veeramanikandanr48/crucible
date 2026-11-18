import assert from 'node:assert/strict';
import test from 'node:test';
import { collectExportBlob } from '../scripts/agent-native-trace.mjs';
import {
  countNativeExport, describeCapacityUse, nativeCapacityProblem, readNativeCapacity, requireExportFitsCapacity,
} from '../scripts/native-capacity.mjs';

const CAPACITY = {
  adapter: 'Test GPU', deviceLocalMemoryBytes: 8_000_000_000, maxUniqueTriangles: 1000, maxInstances: 50, maxTextureTexels: 4096,
  texelBytes: 4, includesAccelerationStructure: false,
};
const FITTING = { uniqueTriangles: 10, instances: 2, textureTexels: 16 };

test('a scene under every limit has no problem', () => {
  assert.equal(nativeCapacityProblem(FITTING, CAPACITY), null);
});

test('a count equal to its limit fits and one more is over, for each limit', () => {
  const cases = [['uniqueTriangles', 'maxUniqueTriangles', 'unique triangles'], ['instances', 'maxInstances', 'instances'], ['textureTexels', 'maxTextureTexels', 'texture texels']];
  for (const [key, limitField, label] of cases) {
    assert.equal(nativeCapacityProblem({ ...FITTING, [key]: CAPACITY[limitField] }, CAPACITY), null, `${key} at its limit fits`);
    const problem = nativeCapacityProblem({ ...FITTING, [key]: CAPACITY[limitField] + 1 }, CAPACITY);
    assert.match(problem, new RegExp(label));
    assert.ok(problem.includes(key), 'names the count field');
    assert.ok(problem.includes(limitField), 'names the limit field');
    assert.ok(problem.includes((CAPACITY[limitField] + 1).toLocaleString('en-US')), 'names the count');
    assert.ok(problem.includes(CAPACITY[limitField].toLocaleString('en-US')), 'names the limit');
    assert.match(problem, /Pass (fewer|smaller)/, 'says what to drop');
  }
});

test('a missing deviceLocalMemoryBytes does not stop the check or the report', () => {
  const { deviceLocalMemoryBytes, ...withoutMemory } = CAPACITY;
  const capacity = { ...withoutMemory, deviceLocalMemorySource: 'no device-local heap' };
  assert.equal(nativeCapacityProblem(FITTING, capacity), null);
  assert.match(nativeCapacityProblem({ ...FITTING, instances: 51 }, capacity), /instances/);
  const use = describeCapacityUse(FITTING, capacity);
  assert.equal(use.deviceLocalMemoryBytes, undefined);
  assert.equal(use.deviceLocalMemoryNote, 'no device-local heap');
});

test('a limit the capacity does not report is not checked', () => {
  assert.equal(nativeCapacityProblem({ uniqueTriangles: 1e9, instances: 1e9, textureTexels: 1e9 }, {}), null);
});

test('the capacity use lists each count with its limit', () => {
  const use = describeCapacityUse(FITTING, CAPACITY);
  assert.deepEqual(use.uniqueTriangles, { used: 10, limit: 1000 });
  assert.deepEqual(use.instances, { used: 2, limit: 50 });
  assert.deepEqual(use.textureTexels, { used: 16, limit: 4096 });
  assert.equal(use.deviceLocalMemoryBytes, 8_000_000_000);
});

test('counts come from the manifest of a chunked export', () => {
  const manifest = { counts: { triangleCount: 7, instanceCount: 3 }, chunks: { tables: { textureTexels: 64 }, chunkBytes: 48 } };
  assert.deepEqual(countNativeExport(manifest, { texelBytes: 4 }), { uniqueTriangles: 7, instances: 3, textureTexels: 16 });
  assert.deepEqual(countNativeExport({ triangles: 5, tables: {} }), { uniqueTriangles: 5, instances: 0, textureTexels: 0 });
});

test('collectExportBlob refuses an over-capacity scene before reading the blob', async () => {
  const manifest = { counts: { triangleCount: 5000, instanceCount: 1 }, chunks: { tables: { triangles: 8 }, chunkBytes: 48 } };
  let chunksRead = 0;
  await assert.rejects(
    collectExportBlob(manifest, async () => { chunksRead++; return new Uint8Array(8); }, { capacity: CAPACITY }),
    error => error.nativeCapacity === true && /5,000 unique triangles/.test(error.message),
  );
  assert.equal(chunksRead, 0);
});

test('collectExportBlob returns the capacity use of a scene that fits', async () => {
  const manifest = { counts: { triangleCount: 1, instanceCount: 1 }, chunks: { tables: { triangles: 4 }, chunkBytes: 48 } };
  const exported = await collectExportBlob(manifest, async () => Uint8Array.from([1, 2, 3, 4]), { capacity: CAPACITY });
  assert.equal(exported.capacityUse.uniqueTriangles.used, 1);
  const unchecked = await collectExportBlob(manifest, async () => Uint8Array.from([1, 2, 3, 4]));
  assert.equal(unchecked.capacityUse, undefined);
});

test('requireExportFitsCapacity throws a RangeError marked as a capacity failure', () => {
  assert.throws(() => requireExportFitsCapacity({ instances: 51, triangles: 1 }, CAPACITY), error => error instanceof RangeError && error.nativeCapacity === true);
});

test('readNativeCapacity reads once per engine and explains a missing or failing read', () => {
  let reads = 0;
  const engine = { readAdapterCapacity: () => { reads++; return CAPACITY; } };
  assert.equal(readNativeCapacity(engine).capacity, CAPACITY);
  readNativeCapacity(engine);
  assert.equal(reads, 1);
  assert.match(readNativeCapacity({}).reason, /no readAdapterCapacity/);
  const failing = readNativeCapacity({ readAdapterCapacity() { throw new Error('built before adapterCapacity existed'); } });
  assert.equal(failing.capacity, undefined);
  assert.match(failing.reason, /built before adapterCapacity existed/);
});
