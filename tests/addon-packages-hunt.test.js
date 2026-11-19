import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { decodePfm, encodePfm } from '../packages/denoise-oidn/index.mjs';
import { fromThreeObject, toThreeObject } from '../packages/three-bridge/index.mjs';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function trianglePart(extra, material) {
  return {
    name: 'triangle',
    geometry: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), ...extra },
    matrix: IDENTITY,
    material,
  };
}

test('decodePfm refuses a PFM whose pixel data is shorter than its header says', () => {
  const bytes = encodePfm(new Float32Array(4 * 3 * 3).map((_, index) => index + 1), 4, 3);
  assert.throws(() => decodePfm(bytes.subarray(0, bytes.length - 16), 4, 3), /bytes of pixels, but 4 x 3 need 144/);
  assert.throws(() => decodePfm(bytes.subarray(0, bytes.length - 13), 4, 3), /bytes of pixels/);
});

test('fromThreeObject names a mesh without a material, and skipUnsupported leaves it out', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.material = undefined;
  const root = new THREE.Group();
  root.add(mesh);
  assert.throws(() => fromThreeObject(root), error => error.name === 'ThreeBridgeError' && /has no material/.test(error.message));
  assert.deepEqual(fromThreeObject(root, { skipUnsupported: true }).parts, []);
});

test('toThreeObject turns vertex colours on only for parts that carry them, even on a shared material', () => {
  const material = { color: [1, 1, 1], metallic: 0, roughness: 1 };
  const colored = trianglePart({ colors: new Float32Array(9).fill(0.5) }, material);
  const plain = trianglePart({}, material);
  const { object } = toThreeObject([colored, plain], THREE);
  assert.equal(object.children[0].material.vertexColors, true);
  assert.equal(object.children[1].material.vertexColors, false);
});
