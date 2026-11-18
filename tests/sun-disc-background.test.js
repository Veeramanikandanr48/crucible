import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { environmentBackgroundFragment } from '../src/environment.js';
import { DEFAULT_SUN_ANGULAR_RADIUS } from '../src/environment-shading.js';

function skyEnvironment(sky, extra = {}) {
  return normalizeAgentLook({ environment: { sky: { type: 'physical', ...sky }, ...extra } }).environment;
}

function peak(values) {
  return values.reduce((largest, value) => Math.max(largest, value), 0);
}

test('the baked physical sky map holds no sun disc and hands the disc to the background pass', () => {
  const withDisc = agentEnvironmentMap(skyEnvironment({ sunElevation: 30, sunDisc: true }));
  const withoutDisc = agentEnvironmentMap(skyEnvironment({ sunElevation: 30, sunDisc: false }));
  assert.deepEqual(Array.from(withDisc.data), Array.from(withoutDisc.data));
  assert.ok(peak(withDisc.data) < 18, 'the map keeps the glow only; the bright disc is drawn per pixel');
  assert.equal(withoutDisc.sunDisc, null);
  const expectedSun = [0, Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)];
  withDisc.sunDisc.direction.forEach((component, axis) => assert.ok(Math.abs(component - expectedSun[axis]) < 1e-9));
  assert.ok(withDisc.sunDisc.radiance.every(component => component > 1));
});

test('a sun below the horizon draws no disc', () => {
  assert.equal(agentEnvironmentMap(skyEnvironment({ sunElevation: -10 })).sunDisc, null);
});

test('the background shader draws the disc from a radius uniform with a screen-space edge', () => {
  assert.match(environmentBackgroundFragment, /uniform float sunDiscRadius;/);
  assert.match(environmentBackgroundFragment, /fwidth\(sunAngle\)/);
});

function recordBackgroundUniforms(map, environment) {
  const values = {};
  const recorder = (location, ...rest) => { values[location] = rest.length === 1 ? rest[0] : rest; };
  const context = new Proxy({}, { get: (_, name) => (String(name).startsWith('uniform') ? recorder : () => {}) });
  const names = ['inverseViewProjection', 'eye', 'backgroundLevel', 'exposure', 'hdrEnabled', 'environmentSpecular', 'environmentRotation', 'environmentIntensity', 'environmentLevelMax', 'sunMapDirection', 'sunDiscRadiance', 'sunDiscRadius'];
  const renderer = {
    context,
    transparent: false,
    hdr: false,
    environment,
    environmentBackgroundProgram: {},
    environmentBackgroundUniforms: Object.fromEntries(names.map(name => [name, name])),
    environmentResources: { levelCount: 4 },
    inverseViewProjection: new Float32Array(16),
  };
  assert.equal(CrucibleRenderer.prototype.drawEnvironmentBackground.call(renderer, map, { eye: [0, 0, 0], environment: {} }, 1), true);
  return values;
}

test('the renderer passes sunAngularRadius and the sun to the background pass', () => {
  const map = agentEnvironmentMap(skyEnvironment({ sunElevation: 30 }, { world: true }));
  const custom = recordBackgroundUniforms(map, { sunAngularRadius: 0.02 });
  assert.equal(custom.sunDiscRadius, 0.02);
  assert.deepEqual(Array.from(custom.sunMapDirection), Array.from(map.sunDisc.direction));
  assert.deepEqual(Array.from(custom.sunDiscRadiance), Array.from(map.sunDisc.radiance));
  assert.equal(recordBackgroundUniforms(map, {}).sunDiscRadius, DEFAULT_SUN_ANGULAR_RADIUS);
  const noDisc = agentEnvironmentMap(skyEnvironment({ sunElevation: 30, sunDisc: false }, { world: true }));
  assert.deepEqual(Array.from(recordBackgroundUniforms(noDisc, {}).sunDiscRadiance), [0, 0, 0]);
});
