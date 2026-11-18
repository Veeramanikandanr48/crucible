import test from 'node:test';
import assert from 'node:assert/strict';
import './support/load-agent-scene-modules.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { execFileSync } from 'node:child_process';
import { normalizeMaterialRetro } from '../src/retro-shader.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { createFragmentShader, createVertexShader, SHADER_FEATURES } from '../src/shaders.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

const RIGID_FEATURES = SHADER_FEATURES.filter(feature => !['crowd', 'skin', 'morph'].includes(feature));

function recipeWithMaterial(material) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', ...material }],
    nodes: [{ id: 'block', geometry: 'box', material: 'finish' }],
  };
}

test('retro accepts a snap grid and the affine switch and freezes the result', () => {
  const retro = normalizeMaterialRetro({ vertexSnap: [160, 120], affineUV: true });
  assert.deepEqual(retro, { vertexSnap: [160, 120], affineUV: true });
  assert.ok(Object.isFrozen(retro));
  assert.deepEqual(normalizeMaterialRetro({ affineUV: true }), { affineUV: true });
  assert.deepEqual(normalizeMaterialRetro({ vertexSnap: [16, 4096], affineUV: false }), { vertexSnap: [16, 4096] });
});

test('retro errors say what to pass', () => {
  assert.throws(() => normalizeMaterialRetro({}), /retro: got \{\}; expected at least one of vertexSnap/);
  assert.throws(() => normalizeMaterialRetro([]), /retro: got \[\]; expected an object/);
  assert.throws(() => normalizeMaterialRetro({ affineUV: false }), /expected at least one of vertexSnap/);
  assert.throws(() => normalizeMaterialRetro({ snap: 4 }), /retro\.snap: .*one of the fields vertexSnap, affineUV; remove snap/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: 160 }), /retro\.vertexSnap: got 160; expected two whole numbers \[width, height\] from 16 to 4096/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [160] }), /retro\.vertexSnap/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [8, 120] }), /from 16 to 4096/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [160, 5000] }), /from 16 to 4096/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [160.5, 120] }), /retro\.vertexSnap/);
  assert.throws(() => normalizeMaterialRetro({ affineUV: 1 }), /retro\.affineUV: got 1; expected true or false/);
});

test('a recipe material and a set-material edit take retro, and a bad value is refused', () => {
  const scene = createAgentScene(recipeWithMaterial({ retro: { vertexSnap: [160, 120], affineUV: true } }));
  assert.deepEqual(scene.parts[0].material.retro, { vertexSnap: [160, 120], affineUV: true });
  assert.throws(() => createAgentScene(recipeWithMaterial({ retro: { vertexSnap: [3, 3] } })), /retro\.vertexSnap/);
  const plain = createAgentScene(recipeWithMaterial({}));
  assert.equal(plain.parts[0].material.retro, undefined);
  plain.apply([{ type: 'set-material', id: 'finish', retro: { affineUV: true } }], { expectedRevision: 0 });
  assert.deepEqual(plain.parts[0].material.retro, { affineUV: true });
  assert.throws(() => plain.apply([{ type: 'set-material', id: 'finish', retro: { vertexSnap: [0, 0] } }], { expectedRevision: 1 }), /retro\.vertexSnap/);
});

test('the retro code loads on demand: the recipe marker finds it, and a renderer without it says which import to add', () => {
  assert.deepEqual(agentSceneModulesNeeded(recipeWithMaterial({ retro: { affineUV: true } })), ['retroShader']);
  assert.deepEqual(agentSceneModulesNeeded(recipeWithMaterial({ roughness: 0.4 })), []);
  const script = `
    const { createVertexShader, createFragmentShader } = await import('./src/shaders.js');
    try { createVertexShader(['retro']); console.log('no error'); } catch (error) { console.log(error.message); }
    console.log(createVertexShader([]).includes('retro'), createFragmentShader([]).includes('affineUV'));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim().split('\n');
  assert.match(output[0], /retro feature needs its shader code: add import '@codepawlhq\/crucible\/addons\/retro-shader'/);
  assert.equal(output[1], 'false false');
});

test('plain shaders carry no retro code', () => {
  assert.doesNotMatch(createVertexShader(RIGID_FEATURES), /retro|affine/i);
  assert.doesNotMatch(createFragmentShader(RIGID_FEATURES), /retro|affine/i);
});

test('the retro feature adds the snap and the affine interpolation to the vertex and fragment shaders', () => {
  const vertex = createVertexShader([...RIGID_FEATURES, 'retro']);
  assert.match(vertex, /uniform vec3 retro;[\s\S]*out vec3 affineUV;/);
  assert.match(vertex, /round\(gl_Position\.xy \/ gl_Position\.w \* halfCells\)/);
  assert.match(vertex, /affineUV = vec3\(uv \* affineWeight, affineWeight\)/);
  const fragment = createFragmentShader([...RIGID_FEATURES, 'retro']);
  assert.ok(fragment.indexOf('in vec2 textureUV, lightmapUV;') < fragment.indexOf('#define textureUV (affineUV.xy / affineUV.z)'), 'the macro follows the declaration');
});

test('the capabilities name the retro field and its raster-only limit', () => {
  assert.match(AGENT_SCENE_CAPABILITIES.materialRetro, /vertexSnap[\s\S]*affineUV[\s\S]*path tracer ignores it/);
});
