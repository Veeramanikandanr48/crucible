import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCookJobTraceScene } from '../bench/cycles-parity/instanced-scene.mjs';
import { TEXTURE_SCENES } from '../bench/cycles-parity/texture-scenes.mjs';

test('the normal-plane parity scene (1.8 x 1.8 x 1 scale) is exported as an instance, as a native render job does', () => {
  const { parts, environment } = TEXTURE_SCENES['normal-plane']();
  const scene = buildCookJobTraceScene(parts, environment, { instancing: false });
  assert.equal(scene.instances.length, 1);
  assert.ok(Math.abs(scene.instances[0].matrix[0] - 1.8) < 1e-6);
  assert.ok(Math.abs(scene.instances[0].matrix[10] - 1) < 1e-6);
});

test('a parity scene without a normal map stays flattened on the job route', () => {
  const { parts, environment } = TEXTURE_SCENES['normal-plane-flat']();
  const scene = buildCookJobTraceScene(parts, environment, { instancing: false });
  assert.equal(scene.instances, undefined);
});
