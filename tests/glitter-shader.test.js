import test from 'node:test';
import assert from 'node:assert/strict';
import './support/load-agent-scene-modules.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeWaterGlint, WATER_GLINT_LIMITS } from '../src/glitter-shader.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { createFragmentShader, SHADER_FEATURES } from '../src/shaders.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { MaterialSnapshot } from '../src/material-snapshot.js';

function recipeWithMaterial(material) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'sea', tag: 'water', ...material }],
    nodes: [{ id: 'sheet', geometry: 'box', material: 'sea' }],
  };
}

test('waterGlint fills the defaults of the parts it names and freezes the result', () => {
  const glint = normalizeWaterGlint({ edge: {}, sparkle: { shape: 'star' } });
  assert.deepEqual(glint.edge, { threshold: 0.4, intensity: 1 });
  assert.deepEqual(glint.sparkle, { density: 0.35, size: 0.12, threshold: 0.985, shape: 'star', twinkle: 1, intensity: 1 });
  assert.ok(Object.isFrozen(glint) && Object.isFrozen(glint.edge) && Object.isFrozen(glint.sparkle));
  assert.equal(normalizeWaterGlint({ edge: { threshold: 0.2 } }).sparkle, undefined);
  assert.equal(normalizeWaterGlint({ sparkle: { twinkle: 0 } }).edge, undefined);
  assert.equal(WATER_GLINT_LIMITS.size.maximum, 2);
});

test('waterGlint errors say what to pass', () => {
  assert.throws(() => normalizeWaterGlint([]), /waterGlint: got \[\]; expected an object, such as/);
  assert.throws(() => normalizeWaterGlint({}), /waterGlint: got \{\}; expected at least one of edge .* or sparkle/);
  assert.throws(() => normalizeWaterGlint({ streaks: {} }), /waterGlint\.streaks: .*one of the fields edge, sparkle; remove streaks/);
  assert.throws(() => normalizeWaterGlint({ edge: 3 }), /waterGlint\.edge: got 3; expected an object/);
  assert.throws(() => normalizeWaterGlint({ edge: { width: 1 } }), /waterGlint\.edge\.width: .*one of the fields threshold, intensity/);
  assert.throws(() => normalizeWaterGlint({ edge: { threshold: 1 } }), /waterGlint\.edge\.threshold: got 1; expected a number from 0\.05 to 0\.95/);
  assert.throws(() => normalizeWaterGlint({ edge: { intensity: 'bright' } }), /waterGlint\.edge\.intensity: .*a number from 0 to 4/);
  assert.throws(() => normalizeWaterGlint({ sparkle: { shape: 'heart' } }), /waterGlint\.sparkle\.shape: got "heart"; expected one of dot, star/);
  assert.throws(() => normalizeWaterGlint({ sparkle: { density: 2 } }), /waterGlint\.sparkle\.density: .*from 0 to 1/);
  assert.throws(() => normalizeWaterGlint({ sparkle: { size: 0 } }), /waterGlint\.sparkle\.size: .*from 0\.02 to 2/);
  assert.throws(() => normalizeWaterGlint({ sparkle: { threshold: 0.5 } }), /waterGlint\.sparkle\.threshold: .*from 0\.9 to 0\.9999/);
  assert.throws(() => normalizeWaterGlint({ sparkle: { twinkle: -1 } }), /waterGlint\.sparkle\.twinkle: .*from 0 to 8/);
  assert.throws(() => normalizeWaterGlint({ sparkle: { count: 3 } }), /waterGlint\.sparkle\.count: .*remove count/);
});

test('a recipe material and a set-material edit take waterGlint on water only', () => {
  const scene = createAgentScene(recipeWithMaterial({ waterGlint: { sparkle: { shape: 'star' } } }));
  assert.equal(scene.parts[0].material.waterGlint.sparkle.shape, 'star');
  assert.throws(() => createAgentScene(recipeWithMaterial({ waterGlint: { sparkle: { density: 3 } } })), /waterGlint\.sparkle\.density/);
  assert.throws(() => createAgentScene(recipeWithMaterial({ tag: 'surface', waterGlint: { edge: {} } })), /waterGlint: got .*expected a water material: set tag "water"/);
  const plain = createAgentScene(recipeWithMaterial({}));
  assert.equal(plain.parts[0].material.waterGlint, undefined);
  plain.apply([{ type: 'set-material', id: 'sea', waterGlint: { edge: { threshold: 0.3 } } }], { expectedRevision: 0 });
  assert.equal(plain.parts[0].material.waterGlint.edge.threshold, 0.3);
  assert.throws(() => plain.apply([{ type: 'set-material', id: 'sea', waterGlint: { edge: { threshold: 5 } } }], { expectedRevision: 1 }), /waterGlint\.edge\.threshold/);
});

test('the glint code loads on demand: the recipe marker finds it and a plain water scene does not', () => {
  assert.ok(agentSceneModulesNeeded(recipeWithMaterial({ waterGlint: { edge: {} } })).includes('glitterShader'));
  assert.ok(!agentSceneModulesNeeded(recipeWithMaterial({ roughness: 0.1 })).includes('glitterShader'));
});

test('the default water shader carries no glint code, and the feature adds it after the water mirror mix', () => {
  const waterFeatures = SHADER_FEATURES.filter(feature => !['crowd', 'skin', 'morph'].includes(feature));
  assert.doesNotMatch(createFragmentShader([...waterFeatures, 'water']), /waterGlint/);
  const fragment = createFragmentShader([...waterFeatures, 'water', 'waterGlint']);
  assert.match(fragment, /uniform vec4 waterGlintEdge;[\s\S]*float waterGlintSparkles\(/);
  const mirrorMix = fragment.indexOf('radiance = mix(radiance * 0.6');
  const refraction = fragment.indexOf('refractedBackground(radiance');
  const glintCode = fragment.indexOf('if (TAG_WATER && (waterGlintEdge.x > 0.0');
  assert.ok(mirrorMix > 0 && refraction > mirrorMix && glintCode > refraction, 'the glint is added after the mirror mix and the refraction blend');
});

test('a material with waterGlint is not snapshotted, so a change to it is seen', () => {
  assert.equal(MaterialSnapshot.of({ tag: 'water', waterGlint: normalizeWaterGlint({ edge: {} }) }), null);
});

test('the capabilities name the fields and the raster-only limit', () => {
  assert.match(AGENT_SCENE_CAPABILITIES.materialWaterGlint, /edge[\s\S]*sparkle[\s\S]*density[\s\S]*twinkle[\s\S]*path tracer ignores it/);
});

test('sparkles are four-point stars unless the shape says dot (#2036)', () => {
  assert.equal(normalizeWaterGlint({ sparkle: {} }).sparkle.shape, 'star');
  assert.equal(normalizeWaterGlint({ sparkle: { density: 0.5 } }).sparkle.shape, 'star');
  assert.equal(normalizeWaterGlint({ sparkle: { shape: 'dot' } }).sparkle.shape, 'dot');
});
