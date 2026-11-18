import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';

// Issue 2116: the "Spray from the sea" example of docs/physics.md ran into a missing node and a mesh name that matched nothing.

await loadPhysicsEngine({ buoyancy: true });

async function sprayExampleRecipe() {
  const guide = await readFile(new URL('../docs/physics.md', import.meta.url), 'utf8');
  const section = guide.slice(guide.indexOf('### Spray from the sea'));
  const block = /```jsonc?\n([\s\S]*?)```/.exec(section);
  assert.ok(block, 'the spray section has a json example');
  return JSON.parse(block[1].replace(/^\s*\/\/.*$/gm, ''));
}

test('the spray example of the guide builds as written and drops droplets from the sea', async () => {
  const recipe = await sprayExampleRecipe();
  const scene = createAgentScene(recipe);
  scene.sampleMotion(0.7);
  const droplets = scene.parts.find(part => part.name === 'droplet').geometry.positions;
  assert.equal(droplets.length / 3, 400 * 24, 'one 24 vertex box per droplet');
});
