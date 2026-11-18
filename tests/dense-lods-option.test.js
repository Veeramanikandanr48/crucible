// A scene file's renderer option `denseLods` gives a dense scan levels of detail (#1163); without it the parts are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sphere } from '../src/geometry.js';
import { partsForRendererOptions } from '../src/dense-lods.js';

function scanPart() {
  return { name: 'scan', geometry: sphere(200, 100), matrix: new Float32Array(16), material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 } };
}

const SMALL_CANVAS = { clientWidth: 20, clientHeight: 20 };
const HUGE_CANVAS = { clientWidth: 8000, clientHeight: 8000 };

test('denseLods true gives levels to a scan that has more than one triangle per pixel', () => {
  const parts = [scanPart()];
  const result = partsForRendererOptions(parts, SMALL_CANVAS, { denseLods: true, pixelRatio: 1 });
  assert.notEqual(result, parts);
  assert.ok(result[0].lods.length > 1, 'the part carries levels');
});

test('without denseLods, or with it false, the same parts come back', () => {
  const parts = [scanPart()];
  assert.equal(partsForRendererOptions(parts, SMALL_CANVAS, {}), parts);
  assert.equal(partsForRendererOptions(parts, SMALL_CANVAS, { denseLods: false }), parts);
  assert.equal(partsForRendererOptions(parts, SMALL_CANVAS), parts);
});

test('the pixel ratio counts: the same scan is sparse on a big canvas', () => {
  const parts = [scanPart()];
  assert.equal(partsForRendererOptions(parts, HUGE_CANVAS, { denseLods: true, pixelRatio: 1 }), parts);
  assert.notEqual(partsForRendererOptions(parts, SMALL_CANVAS, { denseLods: true, pixelRatio: 1 }), parts);
});

test('denseLods must be a boolean, and the error says so', () => {
  assert.throws(() => partsForRendererOptions([scanPart()], SMALL_CANVAS, { denseLods: 'yes' }), /renderer\.denseLods must be true or false/);
});
