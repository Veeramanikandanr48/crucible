import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeAgentLook } from '../src/agent-look.js';

const EXPLICIT_KEY_COLOR = [0.5, 0.62, 1];
const EXPLICIT_FOG_COLOR = [0.14, 0.2, 0.3];

function environmentFor(fields) {
  return normalizeAgentLook({ environment: fields }).environment;
}

function sceneWithEnvironment(environment) {
  return createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], environment });
}

test('a blue-hour preset alone keeps the colours the sky derives', () => {
  const environment = environmentFor({ sky: { type: 'physical', preset: 'blue-hour' } });
  assert.notDeepEqual(environment.keyColor, EXPLICIT_KEY_COLOR);
  assert.ok(environment.fogDensity > 0);
});

test('an explicit keyColor, fogColor and fogDensity beat the sky preset', () => {
  const environment = environmentFor({ sky: { type: 'physical', preset: 'blue-hour', sunElevation: -7, sunRotation: 0.9 }, keyColor: EXPLICIT_KEY_COLOR, fogColor: EXPLICIT_FOG_COLOR, fogDensity: 0.01 });
  assert.deepEqual(environment.keyColor, EXPLICIT_KEY_COLOR);
  assert.deepEqual(environment.fogColor, EXPLICIT_FOG_COLOR);
  assert.equal(environment.fogDensity, 0.01);
  assert.equal(environment.sky.sunElevation, -7);
});

test('set-environment with a sky and a keyColor keeps the keyColor, and a later sky change follows the sky again', () => {
  const session = sceneWithEnvironment({ sky: { type: 'physical', sunElevation: 60 } });
  const noonKey = [...session.environment.keyColor];
  session.apply([{ type: 'set-environment', environment: { sky: { preset: 'blue-hour' }, keyColor: EXPLICIT_KEY_COLOR, fogColor: EXPLICIT_FOG_COLOR } }], { expectedRevision: 0 });
  assert.deepEqual(session.environment.keyColor, EXPLICIT_KEY_COLOR);
  assert.deepEqual(session.environment.fogColor, EXPLICIT_FOG_COLOR);
  session.apply([{ type: 'set-environment', environment: { sky: { sunElevation: 60 } } }], { expectedRevision: 1 });
  assert.notDeepEqual(session.environment.keyColor, EXPLICIT_KEY_COLOR);
  assert.deepEqual(session.environment.keyColor, noonKey);
});
