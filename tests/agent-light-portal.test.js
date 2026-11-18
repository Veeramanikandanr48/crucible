import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { createLightingState, updateLightingState } from '../src/lighting.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

const WINDOW = { position: [-2, 1.5, 0], direction: [1, 0, 0], up: [0, 1, 0], width: 2, height: 1, portal: true };

function areaLightsFrom(areaLights) {
  return normalizeAgentLook({ environment: { areaLights } }).environment.areaLights;
}

function sceneWithWindow(light = WINDOW) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'white', color: [0.8, 0.8, 0.8] }],
    nodes: [{ id: 'floor', geometry: 'box', material: 'white', translation: [0, -0.05, 0], scale: [4, 0.1, 4] }],
    camera: { eye: [0, 1.5, 3], target: [0, 1, 0], fov: 60, near: 0.05, far: 20 },
    environment: { areaLights: [light] },
  });
}

test('an area light takes portal: true and keeps the field only when true', () => {
  const [portal, emitter, explicitlyOff] = areaLightsFrom([
    WINDOW,
    { position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1 },
    { position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1, portal: false },
  ]);
  assert.equal(portal.portal, true);
  assert.equal(Object.hasOwn(emitter, 'portal'), false);
  assert.equal(Object.hasOwn(explicitlyOff, 'portal'), false);
});

test('a bad portal is rejected with the field name and what to pass', () => {
  assert.throws(() => areaLightsFrom([{ ...WINDOW, portal: 'yes' }]), /environment\.areaLights\[0\]\.portal.*true/s);
  assert.throws(() => areaLightsFrom([WINDOW, { ...WINDOW, portal: 1 }]), /environment\.areaLights\[1\]\.portal/);
  assert.throws(() => areaLightsFrom([{ ...WINDOW, width: 0 }]), /width/);
  assert.throws(() => areaLightsFrom([{ ...WINDOW, height: -1 }]), /height/);
  assert.throws(() => areaLightsFrom([{ ...WINDOW, shape: 'disk' }]), /Unknown area light field/);
});

test('scene_capabilities lists the portal field', () => {
  assert.equal(AGENT_SCENE_CAPABILITIES.lightPortals.field, 'environment.areaLights[].portal');
});

test('the trace scene a render job builds carries the portal and emits nothing from it', () => {
  const scene = sceneWithWindow();
  assert.equal(scene.environment.areaLights[0].portal, true);
  const trace = buildTraceScene(scene.parts, scene.environment);
  assert.equal(trace.lights.portals.length, 1);
  assert.deepEqual(trace.lights.areas, []);
  assert.deepEqual(trace.lights.portals[0].position, WINDOW.position);
  assert.equal(trace.lights.portals[0].width, 2);
  assert.equal(trace.lights.portals[0].height, 1);
  assert.deepEqual(trace.lights.portals[0].normal, [1, 0, 0]);
});

test('without portal the same light is an emitter and no portal reaches the trace scene', () => {
  const { portal: ignored, ...emitter } = WINDOW;
  const scene = sceneWithWindow(emitter);
  const trace = buildTraceScene(scene.parts, scene.environment);
  assert.equal(trace.lights.portals.length, 0);
  assert.equal(trace.lights.areas.length, 1);
});

test('the raster view draws no light from a portal and inspect names it', () => {
  const state = createLightingState();
  updateLightingState(state, normalizeAgentLook({ environment: { areaLights: [{ ...WINDOW, intensity: 5 }] } }).environment);
  assert.equal(state.areaColors[3], 0);
  const emitting = createLightingState();
  const { portal: ignored, ...emitter } = WINDOW;
  updateLightingState(emitting, normalizeAgentLook({ environment: { areaLights: [{ ...emitter, intensity: 5 }] } }).environment);
  assert.equal(emitting.areaColors[3], 5);
  const diagnostics = sceneWithWindow().inspect().diagnostics;
  const found = diagnostics.find(entry => entry.kind === 'portal-ignored-by-raster');
  assert.equal(found.target, 'environment.areaLights[0]');
  assert.match(found.fix, /Cook/);
  assert.equal(sceneWithWindow(emitter).inspect().diagnostics?.some(entry => entry.kind === 'portal-ignored-by-raster') ?? false, false);
});
