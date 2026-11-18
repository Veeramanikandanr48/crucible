import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentScene } from '../src/agent-scene.js';

// The "Spray from the sea" example of docs/physics.md is a whole recipe that sends as written and sprays (#2152), and an emitter on a sea
// that an oceanTime track animates takes its droplets from the crests of the moment they are born, not from the sea frozen at its authored time.

const DROPLET_VERTICES = 24;

async function docsSprayExample() {
  const text = (await readFile(new URL('../docs/physics.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const section = text.slice(text.indexOf('### Spray from the sea'));
  return JSON.parse(/```jsonc?\n([\s\S]*?)```/.exec(section)[1].replace(/^\s*\/\/.*$/gm, ''));
}

function dropletCentres(scene, time) {
  scene.sampleMotion(time);
  const positions = scene.parts.find(part => part.name === 'droplet').geometry.positions;
  const centres = [];
  for (let first = 0; first < positions.length / 3; first += DROPLET_VERTICES) {
    const centre = [0, 0, 0];
    for (let vertex = first; vertex < first + DROPLET_VERTICES; vertex++) {
      for (let axis = 0; axis < 3; axis++) centre[axis] += positions[vertex * 3 + axis] / DROPLET_VERTICES;
    }
    centres.push(centre);
  }
  return centres;
}

function seaRecipe({ windSpeed = 14, choppiness = 2, time = 0, track = true } = {}) {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'subdivide', levels: 4 }], stack: [{ op: 'ocean', windSpeed, choppiness, size: 30, seed: 5, resolution: 5, time, spray: true }] },
      { id: 'drop', type: 'icoSphere', subdivisions: 1 },
    ],
    materials: [{ id: 'water' }],
    nodes: [{ id: 'surface', geometry: 'sea', material: 'water' }, { id: 'droplet', geometry: 'drop', material: 'water' }],
    particles: { systems: [{ node: 'droplet', count: 100, rate: 50, speed: [0, 1], lifetime: [0.6, 1.4], size: 0.02,
      emitter: { shape: 'mesh', mesh: 'surface', from: 'surface', group: 'spray', groupThreshold: 0.3, velocityFrom: 'spray' } }] },
  };
  if (track) {
    recipe.motion = { duration: 3, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 3, value: 3 }] }] };
  }
  return recipe;
}

test('the docs spray example builds as written and its droplets leave the water', async () => {
  const scene = createAgentScene(await docsSprayExample());
  const centres = dropletCentres(scene, 0.5);
  assert.equal(centres.length, 400);
  assert.ok(centres.filter(([, height]) => Math.abs(height) > 1e-3).length > 100, 'droplets are born and move off the origin');
});

test('the same sea with the authored time alone has no spray, and the oceanTime track gives it some', () => {
  assert.throws(() => createAgentScene(seaRecipe({ track: false })), /emitter\.mesh[\s\S]*vertex group "spray"/);
  const scene = createAgentScene(seaRecipe());
  const centres = dropletCentres(scene, 2.9);
  const born = centres.filter(centre => centre.some(component => Math.abs(component) > 1e-3));
  assert.ok(born.length >= 100, `${born.length} of 100 droplets have a place after the sea has risen`);
});

test('a sea that never sprays says which ocean setting and track to change', () => {
  assert.throws(() => createAgentScene(seaRecipe({ windSpeed: 0.5, choppiness: 0 })), /ocean\.time[\s\S]*oceanTime track/);
});
