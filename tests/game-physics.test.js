import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene } from '../src/agent-scene.js';
import { loadPhysicsEngine } from '../src/agent-physics.js';
import { startGame } from '../src/game.js';
import { gamePhysicsProblem, hasTexturedMaterial } from '../src/game-needs.js';
import { engineModuleNames, indexHtml, writeWebBuild, WEB_EXPORT_LIMITS } from '../scripts/web-export.mjs';

const EMPTY_RECORDING = { version: 1, samples: 0, events: [] };
const STEP_MILLISECONDS = 1000 / 60;

// A crate dropped on a floor, and a pocket zone the crate must land in. The player stands off to one side.
function physicsRecipe(overrides = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'floor', geometry: 'block', material: 'paint', translation: [0, -0.25, 0], scale: [10, 0.5, 10] },
      { id: 'hero', geometry: 'block', material: 'paint', translation: [4, 0.8, 0], scale: [0.6, 1.6, 0.6] },
      { id: 'crate', geometry: 'block', material: 'paint', translation: [0, 3, 0] },
    ],
    physics: {
      duration: 1,
      bodies: [{ node: 'floor', type: 'fixed', shape: 'box' }, { node: 'hero', type: 'kinematic', shape: 'capsule' }, { node: 'crate', shape: 'box' }],
    },
    game: {
      player: { node: 'hero', footOffset: 0.8 }, camera: 'follow', input: 'keyboard', physics: true, ground: 0,
      rules: {
        version: 1,
        zones: [{ id: 'pocket', shape: 'box', center: [0, 0.5, 0], size: [2, 2, 2] }],
        parts: [{ id: 'hero', tags: ['player'] }, { id: 'crate', tags: ['crate'] }],
        rules: [{ id: 'land', when: { type: 'enter', zone: 'pocket', tag: 'crate' }, do: [{ type: 'win' }] }],
      },
    },
    ...overrides,
  };
}

// The recipe as the MCP session exports it: normalised, with the physics section checked against its nodes.
async function exportedRecipe(overrides) {
  await loadPhysicsEngine();
  return createAgentScene(physicsRecipe(overrides)).exportRecipe();
}

function standInRenderer() {
  return { render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} };
}

async function playFor(recipe, seconds) {
  const game = await startGame({}, recipe, { replay: EMPTY_RECORDING, showStatus: false, createRenderer: () => standInRenderer() });
  for (let step = 0; step < seconds * 60; step++) game.runtime.step(STEP_MILLISECONDS);
  return game;
}

function withAnimationFrameStubs() {
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  };
}

test('a game with physics steps its bodies, moves their nodes and lets a rules zone see them', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const game = await playFor(await exportedRecipe(), 2);
    assert.equal(game.physics.adapter, 'jolt');
    const crate = game.physics.getPose('crate').translation;
    assert.ok(Math.abs(crate[1] - 0.5) < 0.05, `the crate rests on the floor, y ${crate[1]}`);
    const node = game.scene.exportRecipe().nodes.find(candidate => candidate.id === 'crate');
    assert.ok(Math.abs(node.translation[1] - crate[1]) < 1e-6, 'the crate node follows its body');
    assert.equal(game.rules.state.status, 'won', 'the crate landing in the pocket zone fires the rule');
    game.dispose();
  } finally {
    restore();
  }
});

test('a cone body and a compound body fall and rest on the floor in the live runtime', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const recipe = await exportedRecipe({
      nodes: [
        { id: 'floor', geometry: 'block', material: 'paint', translation: [0, -0.25, 0], scale: [10, 0.5, 10] },
        { id: 'hero', geometry: 'block', material: 'paint', translation: [4, 0.8, 0], scale: [0.6, 1.6, 0.6] },
        { id: 'cone', geometry: 'block', material: 'paint', translation: [-2, 3, 0] },
        { id: 'stack', geometry: 'block', material: 'paint', translation: [2, 3, 0] },
      ],
      physics: {
        duration: 1,
        bodies: [
          { node: 'floor', type: 'fixed', shape: 'box' },
          { node: 'hero', type: 'kinematic', shape: 'capsule' },
          { node: 'cone', shape: 'cone' },
          {
            node: 'stack', shape: 'compound',
            shapes: [
              { shape: 'box', halfExtents: [0.5, 0.25, 0.5], translation: [0, -0.25, 0] },
              { shape: 'cylinder', radius: 0.25, halfHeight: 0.25, translation: [0, 0.25, 0] },
            ],
          },
        ],
      },
      game: { player: { node: 'hero', footOffset: 0.8 }, camera: 'follow', input: 'keyboard', physics: true, ground: 0 },
    });
    assert.equal(gamePhysicsProblem(recipe), null);
    const game = await playFor(recipe, 3);
    const cone = game.physics.getPose('cone').translation;
    const stack = game.physics.getPose('stack').translation;
    // The cone fits the unit block: base on the floor puts its centre 0.5 up. The compound's lowest part reaches 0.5 below its origin.
    assert.ok(Math.abs(cone[1] - 0.5) < 0.05, `the cone rests on its base, y ${cone[1]}`);
    assert.ok(Math.abs(stack[1] - 0.5) < 0.05, `the compound rests on its wide part, y ${stack[1]}`);
    for (const [name, position] of [['cone', cone], ['compound', stack]]) {
      assert.ok(Math.hypot(position[0] - (name === 'cone' ? -2 : 2), position[2]) < 0.05, `the ${name} stays where it fell`);
    }
    game.dispose();
  } finally {
    restore();
  }
});

test('the same recipe plays the same physics twice', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const poses = [];
    for (let run = 0; run < 2; run++) {
      const game = await playFor(await exportedRecipe(), 1);
      poses.push(JSON.stringify(game.physics.getPose('crate')));
      game.dispose();
    }
    assert.equal(poses[0], poses[1]);
  } finally {
    restore();
  }
});

test('restart() puts a fallen crate back where the recipe placed it and keeps the physics running', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const game = await playFor(await exportedRecipe(), 1.5);
    const fallen = game.physics.getPose('crate').translation[1];
    assert.ok(fallen < 2, `the crate fell, y ${fallen}`);
    const restarting = game.restart();
    assert.equal(game.physics, null, 'there is no world while it is rebuilt');
    await restarting;
    assert.ok(game.physics, 'the new world is reachable as game.physics');
    assert.ok(Math.abs(game.physics.getPose('crate').translation[1] - 3) < 1e-6, 'the crate is back at the start height');
    for (let step = 0; step < 90; step++) game.runtime.step(STEP_MILLISECONDS);
    assert.ok(game.physics.getPose('crate').translation[1] < 2, 'the crate falls again');
    game.dispose();
  } finally {
    restore();
  }
});

test('steps while the world is rebuilt do nothing, and a second restart or a dispose in that gap leaves one working world', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const game = await playFor(await exportedRecipe(), 0.5);
    const crateBefore = game.scene.exportRecipe().nodes.find(node => node.id === 'crate').translation[1];
    const firstRestart = game.restart();
    const secondRestart = game.restart();
    assert.equal(game.physics, null);
    // Fixed steps, pose operations and the rules' part lookup all run with no world and must not throw.
    for (let step = 0; step < 5; step++) game.runtime.step(STEP_MILLISECONDS);
    const crateY = () => game.scene.exportRecipe().nodes.find(node => node.id === 'crate').translation[1];
    assert.equal(crateY(), crateBefore, 'no pose is written while there is no world');
    await Promise.all([firstRestart, secondRestart]);
    assert.ok(game.physics, 'one world is installed after two restarts');
    assert.ok(Math.abs(game.physics.getPose('crate').translation[1] - 3) < 1e-6);
    game.dispose();
    assert.equal(game.physics, null, 'dispose drops the world');

    const disposedWhileRebuilding = await playFor(await exportedRecipe(), 0.2);
    const pending = disposedWhileRebuilding.restart();
    disposedWhileRebuilding.dispose();
    await pending;
    assert.equal(disposedWhileRebuilding.physics, null, 'a world built after dispose is dropped, not installed');
  } finally {
    restore();
  }
});

test('after a restart the first step writes every dynamic body back to the scene, even one the world leaves where it was sent last', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const recipe = await exportedRecipe();
    recipe.nodes = recipe.nodes.map(node => (node.id === 'crate' ? { ...node, translation: [0, 0.5, 0] } : node));
    const game = await playFor(recipe, 0.5);
    const crateNode = () => game.scene.exportRecipe().nodes.find(node => node.id === 'crate');
    // A fresh world steps the same way every time, so its first step lands exactly where the previous restart's first step did.
    await game.restart();
    game.runtime.step(STEP_MILLISECONDS);
    const restingHeight = crateNode().translation[1];
    // Something else moves the node away; the new world's body is exactly where it was last sent.
    game.scene.apply([{ type: 'set-node', id: 'crate', translation: [0, 10, 0] }], { expectedRevision: game.scene.revision });
    await game.restart();
    game.runtime.step(STEP_MILLISECONDS);
    assert.ok(Math.abs(crateNode().translation[1] - restingHeight) < 0.05, `the crate node was written back, y ${crateNode().translation[1]}`);
    game.dispose();
  } finally {
    restore();
  }
});

test('the kinematic player body pushes a dynamic crate', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const recipe = await exportedRecipe();
    recipe.nodes.find(node => node.id === 'crate').translation = [3, 0.5, 0];
    delete recipe.game.rules;
    const walkRight = { version: 1, samples: 120, truncated: false, events: [[1, 'keyboard/KeyA', 1]] };
    const game = await startGame({}, recipe, { replay: walkRight, showStatus: false, createRenderer: () => standInRenderer() });
    for (let step = 0; step < 120; step++) game.runtime.step(STEP_MILLISECONDS);
    assert.ok(game.physics.getPose('crate').translation[0] < 2.5, 'walking left drives the crate along');
    game.dispose();
  } finally {
    restore();
  }
});

test('a game without physics starts none and does not load the engine files', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const recipe = await exportedRecipe();
    recipe.game.physics = false;
    delete recipe.game.rules;
    const game = await startGame({}, recipe, { replay: EMPTY_RECORDING, showStatus: false, createRenderer: () => standInRenderer() });
    assert.equal(game.physics, null);
    game.dispose();
  } finally {
    restore();
  }
});

test('a physics game without a body list, with joints or with an unsupported shape says what to change', () => {
  assert.match(gamePhysicsProblem({}), /no physics section with bodies.*set-physics/);
  assert.match(gamePhysicsProblem(physicsRecipe({ physics: { duration: 1, bodies: [{ node: 'crate', type: 'dynamic', shape: 'box' }], joints: [{ type: 'fixed' }] } })), /no joints or ragdolls/);
  assert.match(gamePhysicsProblem(physicsRecipe({ physics: { duration: 1, bodies: [{ node: 'floor', type: 'fixed', shape: 'trimesh' }] } })), /Body "floor" has shape trimesh.*builds box, ball, capsule, cylinder, cone, convex, compound.*"box"/);
  assert.equal(gamePhysicsProblem(physicsRecipe()), null);
});

test('the page may only load the physics engine from its own origin', async () => {
  const recipe = await exportedRecipe();
  const previous = globalThis.location;
  globalThis.location = { href: 'http://example.test/index.html', origin: 'http://example.test' };
  try {
    await assert.rejects(
      startGame({}, recipe, { replay: EMPTY_RECORDING, showStatus: false, physicsUrl: 'https://evil.test/jolt-physics.wasm.js', createRenderer: () => standInRenderer() }),
      /physicsUrl must be on the page's own origin/,
    );
  } finally {
    globalThis.location = previous;
  }
});

async function physicsBuild() {
  const build = await mkdtemp(join(tmpdir(), 'crucible-physics-build-'));
  await writeFile(join(build, 'game.js'), 'import { a } from "./chunk-a.js";\nconst physics = () => import("./game-physics-abc123.js");\nconst swap = () => import("./replace-textured-parts.js");\n');
  await writeFile(join(build, 'chunk-a.js'), 'export const a = 1;');
  await writeFile(join(build, 'game-physics-abc123.js'), 'import "./physics-runtime.js";');
  await writeFile(join(build, 'physics-runtime.js'), 'export {};');
  await writeFile(join(build, 'replace-textured-parts.js'), 'export {};');
  return build;
}

test('the web export bundles the physics engine and its wasm beside the page only for a physics game', async () => {
  const build = await physicsBuild();
  assert.deepEqual(await engineModuleNames(build), ['chunk-a.js', 'game.js']);
  assert.deepEqual(await engineModuleNames(build, { physics: true, textured: true }), ['chunk-a.js', 'game-physics-abc123.js', 'game.js', 'physics-runtime.js', 'replace-textured-parts.js']);

  const plain = join(await mkdtemp(join(tmpdir(), 'crucible-web-plain-')), 'site');
  await writeWebBuild({ recipe: physicsRecipe({ game: { ...physicsRecipe().game, physics: false } }), buildDirectory: build, outputDirectory: plain });
  assert.deepEqual((await readdir(join(plain, 'engine'))).sort(), ['chunk-a.js', 'game.js']);
  await assert.rejects(access(join(plain, 'engine', 'physics')));

  const withPhysics = join(await mkdtemp(join(tmpdir(), 'crucible-web-physics-')), 'site');
  const summary = await writeWebBuild({ recipe: physicsRecipe(), buildDirectory: build, outputDirectory: withPhysics });
  assert.deepEqual((await readdir(join(withPhysics, 'engine', 'physics'))).sort(), ['jolt-physics.wasm.js', 'jolt-physics.wasm.wasm']);
  assert.ok(summary.bytes > 1024 * 1024 && summary.bytes < WEB_EXPORT_LIMITS.maxEngineBytes, `physics export bytes ${summary.bytes}`);
  const html = await (await import('node:fs/promises')).readFile(join(withPhysics, 'index.html'), 'utf8');
  assert.match(html, /const physicsUrl = "\.\/engine\/physics\/jolt-physics\.wasm\.js";/);
  assert.match(html, /startGame\(canvas, recipe, \{ replay, assetUrls, physicsUrl \}\)/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(indexHtml('plain'), /physicsUrl/);
});

test('the web export refuses physics it cannot play before it writes anything', async () => {
  const build = await physicsBuild();
  const recipe = physicsRecipe({ physics: { duration: 1, bodies: [{ node: 'crate', shape: 'box' }], joints: [{ type: 'fixed', bodyA: 'crate', bodyB: 'floor' }] } });
  await assert.rejects(writeWebBuild({ recipe, buildDirectory: build, outputDirectory: join(await mkdtemp(join(tmpdir(), 'crucible-web-refuse-')), 'site') }), /no joints or ragdolls/);
});

test('only a recipe with a pattern or a map is textured', () => {
  assert.equal(hasTexturedMaterial(physicsRecipe()), false);
  assert.equal(hasTexturedMaterial({ materials: [{ id: 'm', pattern: { type: 'bricks' } }] }), true);
  assert.equal(hasTexturedMaterial({ materials: [{ id: 'm', normalMap: 'x' }] }), true);
});
