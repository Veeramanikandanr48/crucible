import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { radianceFromHex } from '../src/gradient-sky.js';
import { inverseAcesChannel, radianceForDisplayColor } from '../src/view-transform-inverse.js';
import { acesChannel, displayColor } from '../src/view-transform.js';

const STOPS = [{ at: 0, color: '#1a8a9c' }, { at: 0.45, color: '#127285' }, { at: 1, color: '#0e5d73' }];
const GLOW = { color: '#19d0e8', width: 1, intensity: 1 };

const hexOf = encoded => `#${encoded.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
const channelsOf = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
const largestLevelGap = (first, second) => Math.max(...channelsOf(first).map((level, channel) => Math.abs(level - channelsOf(second)[channel])));

function environmentFor(sky, extra = {}) {
  return normalizeAgentLook({ environment: { world: true, sky: { type: 'gradient', stops: STOPS, ...sky }, ...extra } }).environment;
}

// What the frame shows for one map row: the radiance the map holds, times its strength, through the view transform and the display power.
function shownHex(map, elevation, viewTransform = 'aces') {
  const row = Math.min(map.height - 1, Math.floor((90 - elevation) / 180 * map.height));
  const offset = row * map.width * 3;
  const radiance = [...map.data.slice(offset, offset + 3)].map(channel => channel * map.intensity);
  return hexOf(displayColor(radiance, { viewTransform }));
}

test('the aces inverse returns the channel it was given for the whole 0 to 1 range', () => {
  for (let level = 0; level <= 255; level++) {
    assert.ok(Math.abs(acesChannel(inverseAcesChannel(level / 255)) - level / 255) < 1e-9, `level ${level}`);
  }
  assert.ok(Number.isFinite(inverseAcesChannel(1)));
  assert.equal(inverseAcesChannel(-3), 0);
});

test('a hex goes through the inverse and the display path and comes back as the same hex', () => {
  const hexes = ['#0e5d73', '#127285', '#1a8a9c', '#19d0e8', '#000000', '#ffffff', '#808080', '#ff3a10', '#fefefe'];
  for (const hex of hexes) {
    assert.equal(hexOf(displayColor(radianceFromHex(hex, 'aces'), { viewTransform: 'aces' })), hex);
  }
  for (const hex of ['#0e5d73', '#127285', '#1a8a9c', '#19d0e8', '#808080']) {
    assert.ok(largestLevelGap(hexOf(displayColor(radianceFromHex(hex, 'neutral'), { viewTransform: 'neutral' })), hex) <= 1, `neutral ${hex}`);
  }
});

test('colours the transform cannot show land on the nearest one and report the gap', () => {
  const saturatedRed = [1, 0.23, 0.06];
  const unreachable = radianceForDisplayColor(saturatedRed, 'neutral');
  assert.ok(unreachable.radiance.every(Number.isFinite));
  assert.ok(unreachable.error > 0.01, 'neutral desaturates a saturated red, so no radiance shows it');
  assert.equal(radianceForDisplayColor([0.2, 0.4, 0.5], 'aces').error, 0);
});

test('the gradient shows the requested hex at the horizon, the middle stop, the zenith and the glow peak', () => {
  const map = agentEnvironmentMap(environmentFor({ horizonGlow: GLOW }));
  assert.equal(shownHex(map, 0), GLOW.color);
  assert.equal(shownHex(map, 89.9), '#0e5d73');
  assert.ok(largestLevelGap(shownHex(map, 40.5), '#127285') <= 2);
  assert.ok(largestLevelGap(shownHex(map, 20), '#1a8a9c') > 2, 'the band fades into the gradient above the glow');
  const plain = agentEnvironmentMap(environmentFor({}));
  assert.equal(shownHex(plain, 0), '#1a8a9c');
  assert.equal(shownHex(plain, -30), '#1a8a9c');
});

test('the hex holds under the neutral view transform and a different environment strength', () => {
  const map = agentEnvironmentMap(environmentFor({ horizonGlow: GLOW }, { viewTransform: 'neutral', environmentIntensity: 2 }));
  assert.equal(map.intensity, 2);
  assert.ok(largestLevelGap(shownHex(map, 0, 'neutral'), GLOW.color) <= 2);
  assert.ok(largestLevelGap(shownHex(map, 89.9, 'neutral'), '#0e5d73') <= 2);
});

test('glow intensity above 1 brightens the band and the fog colour follows the compensated horizon', () => {
  const bright = agentEnvironmentMap(environmentFor({ horizonGlow: { ...GLOW, intensity: 2 } }));
  const normal = agentEnvironmentMap(environmentFor({ horizonGlow: GLOW }));
  assert.ok(bright.data[256 * bright.width * 3 + 1] > normal.data[256 * normal.width * 3 + 1] * 1.9);
  const environment = environmentFor({});
  assert.deepEqual(environment.fogColor, radianceFromHex('#1a8a9c', 'aces'));
});

test('stops blend in OKLab, so black to white passes through the perceptual middle grey', () => {
  const map = agentEnvironmentMap(environmentFor({ stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] }));
  assert.ok(largestLevelGap(shownHex(map, 45), '#636363') <= 2);
});
