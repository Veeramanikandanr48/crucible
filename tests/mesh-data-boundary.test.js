import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshData } from '../src/mesh-data.js';

function quad() {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceOffsets: new Uint32Array([0, 4]),
    cornerVertices: new Uint32Array([0, 1, 2, 3]),
  };
}

test('createMeshData refuses an attribute domain it does not store', () => {
  const attributes = { points: { height: { data: new Float32Array(4), size: 1 } } };
  assert.throws(() => createMeshData({ ...quad(), attributes }), /Unknown attribute domain points; use point, edge, face, corner/);
});

test('createMeshData refuses half of an explicit edge table instead of dropping it', () => {
  assert.throws(() => createMeshData({ ...quad(), edgeVertices: new Uint32Array([0, 1]) }), /edgeVertices with cornerEdges/);
  assert.throws(() => createMeshData({ ...quad(), cornerEdges: new Uint32Array([0, 1, 2, 3]) }), /edgeVertices with cornerEdges/);
});

test('createMeshData names a missing or non-object argument', () => {
  assert.throws(() => createMeshData({ ...quad(), attributes: null }), /attributes must be an object/);
  assert.throws(() => createMeshData(), /positions must be a nonempty Float32Array/);
});

test('createMeshData still accepts the four domains and no attributes', () => {
  assert.equal(createMeshData(quad()).edgeCount, 4);
  const attributes = { point: { height: { data: new Float32Array(4), size: 1 } }, face: {}, edge: {}, corner: {} };
  assert.equal(createMeshData({ ...quad(), attributes }).attributes.point.height.size, 1);
});
