import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTraceScene } from '../src/path-tracer-scene.js';

function quadGeometry() {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function scaling(x, y, z) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

const NORMAL_TEXTURE = { width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) };
const OPTION = { instanceNormalMappedParts: true };

function partWith(matrix, material) {
  return { name: 'plane', geometry: quadGeometry(), matrix, material: { color: [0.5, 0.5, 0.5], ...material } };
}

test('a normal-mapped part under a non-uniform scale becomes one instance that keeps its matrix', () => {
  const matrix = scaling(2, 1, 1);
  const scene = buildTraceScene([partWith(matrix, { normalMap: NORMAL_TEXTURE })], {}, OPTION);
  assert.equal(scene.instances.length, 1);
  assert.deepEqual([...scene.instances[0].matrix], matrix);
});

test('a coat normal map alone also asks for the instance', () => {
  const scene = buildTraceScene([partWith(scaling(1, 3, 1), { layerMaps: { clearcoatNormalTexture: NORMAL_TEXTURE } })], {}, OPTION);
  assert.equal(scene.instances.length, 1);
});

test('a shear counts as non-uniform', () => {
  const shear = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.ok(buildTraceScene([partWith(shear, { normalMap: NORMAL_TEXTURE })], {}, OPTION).instances);
});

function flattenedFields(scene) {
  return { positions: [...scene.positions], normals: [...scene.normals], indices: [...scene.indices], uvs: [...scene.uvs] };
}

test('uniform scale, no normal map, and the option left out stay flattened and byte-identical', () => {
  const cases = [
    [partWith(scaling(2, 2, 2), { normalMap: NORMAL_TEXTURE }), OPTION],
    [partWith(scaling(2, 1, 1), {}), OPTION],
    [partWith(scaling(2, 1, 1), { normalMap: NORMAL_TEXTURE }), {}],
  ];
  for (const [part, options] of cases) {
    const withOption = buildTraceScene([part], {}, options);
    const reference = buildTraceScene([part], {}, {});
    assert.equal(withOption.instances, undefined);
    assert.deepEqual(flattenedFields(withOption), flattenedFields(reference));
  }
});

test('a rotation with a uniform scale is not treated as non-uniform', () => {
  const turn = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 5, 0, 0, 1];
  assert.equal(buildTraceScene([partWith(turn, { normalMap: NORMAL_TEXTURE })], {}, OPTION).instances, undefined);
});
