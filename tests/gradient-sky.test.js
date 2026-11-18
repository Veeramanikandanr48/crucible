import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { radianceFromHex } from '../src/gradient-sky.js';

const TEAL_STOPS = [{ at: 0, color: '#1a8a9c' }, { at: 1, color: '#0e5d73' }];
const GLOW = { color: '#19d0e8', width: 3, intensity: 1 };

function gradientEnvironment(sky, extra = {}) {
  return normalizeAgentLook({ environment: { sky: { type: 'gradient', stops: TEAL_STOPS, ...sky }, ...extra } }).environment;
}

function mapPixel(map, elevationDegrees) {
  const row = Math.min(map.height - 1, Math.floor((90 - elevationDegrees) / 180 * map.height));
  const offset = row * map.width * 3;
  return [...map.data.slice(offset, offset + 3)];
}

test('a gradient sky loads the sky code, keeps the sun and sets the sky colours', () => {
  assert.ok(agentSceneModulesNeeded({ environment: { sky: { type: 'gradient' } } }).includes('physicalSky'));
  const environment = gradientEnvironment({});
  assert.deepEqual(environment.lightDirection, [-3, 6, 4]);
  assert.deepEqual(environment.skyBottom, radianceFromHex('#1a8a9c'));
  assert.deepEqual(environment.skyTop, radianceFromHex('#0e5d73'));
});

test('the map runs from the horizon colour to the zenith colour', () => {
  const map = agentEnvironmentMap(gradientEnvironment({}, { world: true }));
  assert.equal(map.showBackground, true);
  const zenith = radianceFromHex('#0e5d73');
  const nearHorizon = radianceFromHex('#1a8a9c');
  mapPixel(map, 89.8).forEach((value, channel) => assert.ok(Math.abs(value - zenith[channel]) < 0.01));
  mapPixel(map, 0.2).forEach((value, channel) => assert.ok(Math.abs(value - nearHorizon[channel]) < 0.02));
  assert.equal(agentEnvironmentMap(gradientEnvironment({}, { world: true })), map);
});

test('the horizon glow is a band: bright at the horizon and gone well above it', () => {
  const map = agentEnvironmentMap(gradientEnvironment({ horizonGlow: GLOW }));
  const plain = agentEnvironmentMap(gradientEnvironment({}));
  const glowColor = radianceFromHex(GLOW.color);
  const [atHorizon, high] = [mapPixel(map, 0), mapPixel(map, 30)];
  atHorizon.forEach((value, channel) => assert.ok(Math.abs(value - glowColor[channel] * GLOW.intensity) < 0.02));
  assert.ok(atHorizon[1] > mapPixel(plain, 0)[1] + 0.2);
  // Hue is kept: the band is the glow colour scaled, so the red to green ratio of the peak is the glow's, not the sky's.
  assert.ok(Math.abs(atHorizon[0] / atHorizon[1] - glowColor[0] / glowColor[1]) < 0.02);
  assert.ok(Math.abs(high[1] - mapPixel(plain, 30)[1]) < 1e-4);
  assert.ok(map.data.every(Number.isFinite));
});

test('stops and glow are checked with messages that say what to pass', () => {
  assert.throws(() => gradientEnvironment({ stops: [] }), /environment\.sky\.stops.*1 to 8/s);
  const nine = Array.from({ length: 9 }, (_, index) => ({ at: index / 8, color: '#102030' }));
  assert.throws(() => gradientEnvironment({ stops: nine }), /environment\.sky\.stops/);
  assert.throws(() => gradientEnvironment({ stops: [{ at: 0.5, color: '#102030' }, { at: 0.5, color: '#102030' }] }), /stops\[1\]\.at.*larger than the stop before/s);
  assert.throws(() => gradientEnvironment({ stops: [{ at: 1.5, color: '#102030' }] }), /stops\[0\]\.at/);
  assert.throws(() => gradientEnvironment({ stops: [{ at: 0, color: 'teal' }] }), /stops\[0\]\.color.*hex colour/s);
  assert.throws(() => gradientEnvironment({ horizonGlow: { color: '#7ff4ff', width: 0 } }), /horizonGlow\.width.*0\.5 to 45/s);
  assert.throws(() => gradientEnvironment({ horizonGlow: { width: 3 } }), /horizonGlow\.color/);
  assert.throws(() => gradientEnvironment({ horizonGlow: { color: '#7ff4ff', spread: 3 } }), /horizonGlow.*spread/s);
  assert.throws(() => gradientEnvironment({ sunElevation: 10 }), /environment\.sky.*sunElevation/s);
});

test('set-environment switches between a physical and a gradient sky and edits one gradient field', () => {
  const session = createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    environment: { sky: { type: 'physical', sunElevation: 60 } } });
  session.apply([{ type: 'set-environment', environment: { sky: { type: 'gradient', stops: TEAL_STOPS } } }], { expectedRevision: 0 });
  assert.equal(session.environment.sky.type, 'gradient');
  assert.equal(session.environment.sky.sunElevation, undefined);
  session.apply([{ type: 'set-environment', environment: { sky: { horizonGlow: GLOW } } }], { expectedRevision: 1 });
  assert.equal(session.environment.sky.horizonGlow.color, GLOW.color);
  assert.equal(session.environment.sky.stops.length, 2);
});
