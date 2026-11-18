import './support/load-agent-scene-modules.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { createHash } from 'node:crypto';
import { EXPLOSION_EMPTY_GRID, EXPLOSION_EMPTY_VELOCITY_GRID, explosionGridBytes, setExplosionBakeStore } from '../src/explosion-grids.js';
import { decodeVolumeGrid, hasGridVelocity } from '../src/volume-grid.js';
import { readVolumeGridFiles } from '../src/mcp-volume-grids.js';
import { agentSceneModulesNeeded, needsPhysics } from '../src/agent-scene-modules.js';
import { findCoplanarOverlaps } from '../src/coplanar-overlap.js';

await loadPhysicsEngine();

// The bake cache in explosion-grids.js keeps 4 bakes and drops the oldest, so this file's blasts (about 10 seeds and fuels) would bake the same
// grids again after they were evicted. A store that keeps every bake in memory for the file lets each fuel, seed and velocity bake once.
const keptBakes = new Map();
setExplosionBakeStore({
  load: descriptor => keptBakes.get(JSON.stringify(descriptor)) ?? null,
  save: (descriptor, frames) => keptBakes.set(JSON.stringify(descriptor), frames),
});
after(() => setExplosionBakeStore(null));

function setRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }, { id: 'round', type: 'cylinder' }],
    materials: [{ id: 'stone', color: [0.4, 0.4, 0.4] }, { id: 'wood', color: [0.5, 0.3, 0.15] }],
    nodes: [
      { id: 'ground', geometry: 'round', material: 'stone', translation: [0, -0.1, 0], scale: [9, 0.2, 9] },
      { id: 'crate', geometry: 'slab', material: 'wood', translation: [2.6, 0.5, -1.2] },
    ],
    camera: { eye: [13, 10, 13], target: [0, 1.5, 0], fov: 32 },
    physics: { duration: 3, bodies: [{ node: 'ground', type: 'fixed', shape: 'box' }] },
  };
}

const blast = (extra = {}) => ({ type: 'add-explosion', id: 'blast', center: [0, 0, 0], size: 6, ...extra });

function applyBlast(operation, recipe = setRecipe()) {
  const scene = createAgentScene(recipe);
  const result = scene.apply([operation], { expectedRevision: scene.inspect({}).revision });
  return { scene, result, recipe: scene.exportRecipe() };
}

test('the operation is listed, loads its modules and asks for the physics engine only with debris', () => {
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('add-explosion'));
  assert.match(AGENT_SCENE_CAPABILITIES.explosion, /add-explosion/);
  const modules = agentSceneModulesNeeded([blast()]);
  for (const name of ['explosion', 'motion', 'particles', 'fogShader', 'postSteps']) assert.ok(modules.includes(name), name);
  assert.equal(needsPhysics([blast()]), false);
  assert.equal(needsPhysics([blast({ debris: { node: 'crate' } })]), true);
});

test('a blast writes plain sections, every part ID starting with the explosion ID', () => {
  const { recipe } = applyBlast(blast({ start: 0.5, fuel: 'oily' }));
  assert.equal([recipe.effects.flash].flat()[0].startTime, 0.5);
  assert.equal(recipe.effects.distortion[0].shape, 'ring');
  assert.equal(recipe.environment.localVolumes.length, 1);
  const volume = recipe.environment.localVolumes[0];
  assert.equal(volume.shape, 'grid');
  assert.equal(volume.castShadow, true);
  assert.equal(volume.lightsScene, true);
  assert.equal(volume.loop, false);
  assert.equal(volume.detailNoise, undefined, 'a blast writes no detail noise unless asked (#1832)');
  assert.ok(volume.blackbodyIntensity > 0 && volume.temperatureScale === 1000);
  assert.equal(volume.frames.filter(name => name === EXPLOSION_EMPTY_VELOCITY_GRID).length, Math.ceil(0.5 * volume.fps));
  assert.equal(volume.frames.at(-1), 'explosion-oily-1-velocity_0071.67vg');
  assert.deepEqual(recipe.particles.systems.map(system => system.node), ['blast-sparks', 'blast-dust', 'blast-rubble']);
  assert.ok(recipe.particles.systems.every(system => system.delay === 0.5));
  const added = [...recipe.nodes, ...recipe.geometries, ...recipe.materials].map(entry => entry.id).filter(id => id.startsWith('blast-'));
  assert.ok(added.length >= 10);
  assert.ok(recipe.nodes.some(node => node.id === 'blast-scorch' && node.decal === true));
  const shake = recipe.motion.tracks.find(track => track.kind === 'camera');
  assert.deepEqual(shake.keyframes.at(-1).value, recipe.camera.eye);
  assert.ok(shake.keyframes.some(key => key.value[0] !== recipe.camera.eye[0]));
  assert.ok(recipe.motion.duration > 0.5 + 72 / volume.fps);
  assert.deepEqual(recipe.nodes.find(node => node.id === 'crate').translation, [2.6, 0.5, -1.2]);
});

test('the same seed gives a byte-identical recipe, another seed a different one', () => {
  const first = JSON.stringify(applyBlast(blast({ seed: 5, debris: { node: 'crate' } })).recipe);
  const second = JSON.stringify(applyBlast(blast({ seed: 5, debris: { node: 'crate' } })).recipe);
  const other = JSON.stringify(applyBlast(blast({ seed: 6, debris: { node: 'crate' } })).recipe);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test('the expanded recipe passes scene_create validation and the scene samples at any time', () => {
  const { recipe } = applyBlast(blast({ start: 1, debris: { node: 'crate' } }));
  const scene = createAgentScene(recipe);
  assert.equal(scene.inspect({}).particles.systems.length, 3);
});

test('debris fractures the node into loose pieces thrown by impulse events at the start tick', () => {
  const { recipe } = applyBlast(blast({ start: 0.5, debris: { node: 'crate' } }));
  assert.ok(!recipe.nodes.some(node => node.id === 'crate'));
  const pieces = recipe.nodes.filter(node => node.id.startsWith('crate-frag-'));
  assert.equal(pieces.length, 12);
  assert.equal(recipe.physics.joints, undefined);
  assert.equal(recipe.physics.events.length, 12);
  assert.ok(recipe.physics.events.every(event => event.tick === 30 && event.impulse.some(component => component !== 0)));
  assert.ok(recipe.physics.duration >= 3.5);
});

test('shake is skipped when the camera already has an eye track and refused when asked for', () => {
  const recipe = setRecipe();
  recipe.motion = { duration: 2, tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [13, 10, 13] }, { time: 2, value: [12, 10, 13] }] }] };
  const { recipe: result } = applyBlast(blast(), recipe);
  assert.equal(result.motion.tracks.filter(track => track.kind === 'camera').length, 1);
  assert.throws(() => applyBlast(blast({ shake: 0.5 }), setRecipeWithEyeTrack()), /shake/);
});

function setRecipeWithEyeTrack() {
  const recipe = setRecipe();
  recipe.motion = { duration: 2, tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [13, 10, 13] }, { time: 2, value: [12, 10, 13] }] }] };
  return recipe;
}

test('bad input names the field and a valid value', () => {
  const cases = [
    [blast({ id: 'a b' }), /id/],
    [blast({ id: 5 }), /id/],
    [blast({ center: [0, 0] }), /center/],
    [blast({ size: 0 }), /size.*0\.5 to 100/],
    [blast({ size: 101 }), /size/],
    [blast({ start: -1 }), /start/],
    [blast({ seed: 1.5 }), /seed/],
    [blast({ fuel: 'nuclear' }), /fuel.*dry, oily/],
    [blast({ shake: 2 }), /shake/],
    [blast({ extra: 1 }), /extra/],
    [blast({ debris: { node: 'missing' } }), /debris\.node.*existing node/],
    [blast({ debris: {} }), /debris\.node/],
  ];
  for (const [operation, pattern] of cases) assert.throws(() => applyBlast(operation), pattern, JSON.stringify(operation));
});

test('debris needs a physics floor, and a second blast needs a new ID and no other grid volume', () => {
  const recipe = setRecipe();
  delete recipe.physics;
  assert.throws(() => applyBlast(blast({ debris: { node: 'crate' } }), recipe), /fixed floor/);
  const scene = createAgentScene(setRecipe());
  scene.apply([blast()], { expectedRevision: scene.inspect({}).revision });
  assert.throws(() => scene.apply([blast()], { expectedRevision: scene.inspect({}).revision }), /blast-/);
  assert.throws(() => scene.apply([blast({ id: 'second' })], { expectedRevision: scene.inspect({}).revision }), /grid volume/);
});

test('the fireball is a gas-sim grid volume scaled to the blast size: box, density, emission and playback speed', () => {
  const small = applyBlast(blast({ size: 2.5 })).recipe.environment.localVolumes[0];
  const large = applyBlast(blast({ size: 10 })).recipe.environment.localVolumes[0];
  assert.deepEqual(small.size, [8, 8, 8]);
  assert.deepEqual(large.size, [32, 32, 32]);
  assert.equal(small.fps, 24);
  assert.ok(small.steps <= 32, 'a CPU preview look must fit its 30 s limit, so the march stays at one step per voxel');
  assert.equal(large.fps, 12);
  assert.equal(small.density / large.density, 4);
  assert.equal(small.emissionStrength / large.emissionStrength, 4);
  assert.equal(small.emissionStrength, 9.5, 'the reference-size emission that keeps the core from clipping to white and the edge soft like the Cycles frame (#1736)');
  assert.deepEqual(small.center, [0, 4, 0]);
  const oily = applyBlast(blast({ size: 2.5, fuel: 'oily' })).recipe.environment.localVolumes[0];
  assert.equal(oily.density, 1.5 * small.density);
  assert.notDeepEqual(oily.frames, small.frames);
  const raised = applyBlast(blast({ size: 2.5, center: [1, 2, 3], ground: 0 })).recipe.environment.localVolumes[0];
  assert.deepEqual(raised.center, [1, 6, 3]);
});

test('the grids the recipe names are baked from the name, byte for byte, and tied to the seed and the fuel', () => {
  const { frames } = applyBlast(blast({ seed: 1 })).recipe.environment.localVolumes[0];
  assert.equal(frames.length, 72);
  assert.equal(frames[0], 'explosion-dry-1-velocity_0000.67vg');
  const first = explosionGridBytes(frames[10]);
  const again = explosionGridBytes(frames[10]);
  assert.ok(first.length > 1000);
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, explosionGridBytes('explosion-dry-5-velocity_0010.67vg'));
  assert.notDeepEqual(first, explosionGridBytes('explosion-oily-1-velocity_0010.67vg'));
  assert.equal(explosionGridBytes('explosion-dry-1-velocity_0072.67vg'), null);
  assert.equal(explosionGridBytes('explosion-dry-1-fast_0010.67vg'), null);
  assert.equal(explosionGridBytes('blast.67vg'), null);
  assert.ok(explosionGridBytes(EXPLOSION_EMPTY_GRID).length > 1000);
});

test('the wait before a blast is empty grid frames, bounded by the frame list', () => {
  const waited = applyBlast(blast({ size: 2.5, start: 2 })).recipe.environment.localVolumes[0];
  assert.equal(waited.frames.length, 72 + 48);
  assert.ok(waited.frames.slice(0, 48).every(name => name === EXPLOSION_EMPTY_VELOCITY_GRID));
  assert.throws(() => applyBlast(blast({ size: 2.5, start: 30 })), /start.*at most 18\.3 s.*512/);
});

test('a scene with a grid volume already refuses the blast and says how to make room', () => {
  const recipe = setRecipe();
  recipe.environment = { localVolumes: [{ shape: 'grid', grid: 'explosion-empty.67vg', center: [0, 1, 0], size: [2, 2, 2] }] };
  assert.throws(() => applyBlast(blast(), recipe), /grid volume.*set-environment/);
});

test('the MCP server finds the grids an add-explosion operation will name, so the page gets them with the call', () => {
  const files = readVolumeGridFiles([blast({ seed: 1, fuel: 'oily', start: 1 })], '.');
  assert.equal(files.size, 73);
  assert.ok(files.has('explosion-oily-1-velocity_0000.67vg'));
  assert.ok(files.has(EXPLOSION_EMPTY_VELOCITY_GRID));
  const sharp = readVolumeGridFiles([blast({ seed: 1, motionBlur: false })], '.');
  assert.equal(sharp.size, 73);
  assert.ok(sharp.has('explosion-dry-1_0071.67vg'));
  assert.ok(sharp.has(EXPLOSION_EMPTY_GRID));
  assert.equal(readVolumeGridFiles([blast({ fuel: 'nuclear' })], '.').size, 0);
  assert.equal(readVolumeGridFiles([blast({ seed: -1 })], '.').size, 0);
});

// Both options are off: the recipe is the one the first release wrote, byte for byte (hashes taken from main before #1775, refreshed for #1736's emission change and #1735's flame remap and unraised bloom).
const FIRST_RELEASE_HASHES = new Map([
  ['{}', 'df70567bd19d0d575a77bf3d6b8209768f859d0ac689986baa46c15075f1b7f0'],
  ['{"start":0.5,"fuel":"oily","seed":7}', '9c8225756d33fd331a836f0018a4c78200f1d9a55a41d91355c833eebf8f535e'],
]);

test('sparks specks and motionBlur false write exactly the recipe of the first release, and false is an alias of specks', () => {
  const plainRecipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }],
    materials: [{ id: 'stone', color: [0.4, 0.4, 0.4] }],
    nodes: [{ id: 'ground', geometry: 'slab', material: 'stone', scale: [9, 0.2, 9] }],
    camera: { eye: [13, 10, 13], target: [0, 1.5, 0], fov: 32 },
  };
  for (const [extra, hash] of FIRST_RELEASE_HASHES) {
    for (const sparks of ['specks', false]) {
      const { recipe } = applyBlast(blast({ ...JSON.parse(extra), sparks, motionBlur: false }), structuredClone(plainRecipe));
      assert.equal(createHash('sha256').update(JSON.stringify(recipe)).digest('hex'), hash, `${extra} sparks ${sparks}`);
    }
  }
});

test('sparks streaks, specks and none, with true as an alias of streaks', () => {
  const systems = sparks => applyBlast(blast({ sparks })).recipe.particles.systems;
  for (const value of ['streaks', true]) assert.equal(systems(value)[0].type, 'sparks', String(value));
  for (const value of ['specks', false]) {
    assert.equal(systems(value)[0].type, 'emitter', String(value));
    assert.equal(systems(value)[0].node, 'blast-sparks');
  }
  const none = applyBlast(blast({ sparks: 'none' })).recipe;
  assert.deepEqual(none.particles.systems.map(system => system.node), ['blast-dust', 'blast-rubble']);
  assert.ok(!none.nodes.some(node => node.id === 'blast-sparks'));
  assert.ok(!none.materials.some(material => material.id === 'blast-spark-glow'));
  assert.ok(!none.particles.systems.some(system => system.type === 'sparks'));
  assert.equal(createAgentScene(none).inspect({}).particles.systems.length, 2);
});

test('by default the sparks are streaks born at start and the fireball grid carries velocity under a shutter', () => {
  const { recipe } = applyBlast(blast({ start: 0.5 }));
  const [sparks] = recipe.particles.systems;
  assert.equal(sparks.type, 'sparks');
  assert.equal(sparks.count, 700);
  assert.equal(sparks.delay, 0.5);
  assert.deepEqual(sparks.speed, [2 * Math.sqrt(6 / 2.5), 9 * Math.sqrt(6 / 2.5)].map(value => Number(value.toFixed(5))));
  const glow = recipe.materials.find(material => material.id === 'blast-spark-glow');
  assert.equal(glow.tag, 'unlit');
  assert.deepEqual(glow.color, [1, 1, 1]);
  assert.equal(recipe.effects.motionBlur.shutter, 0.0417);
  const volume = recipe.environment.localVolumes[0];
  assert.ok(volume.frames.every(name => name.includes('-velocity_') || name === EXPLOSION_EMPTY_VELOCITY_GRID));
  assert.ok(hasGridVelocity(decodeVolumeGrid(explosionGridBytes(volume.frames.at(-1)))));
  assert.ok(hasGridVelocity(decodeVolumeGrid(explosionGridBytes(EXPLOSION_EMPTY_VELOCITY_GRID))));
  assert.equal(applyBlast(blast({ fuel: 'oily' })).recipe.particles.systems[0].count, 900);
});

test('the blast leaves the scene bloom as it is, so the fire glows only as far as its own emission (#1735)', () => {
  const plain = applyBlast(blast()).recipe.effects.bloom;
  assert.equal(plain.strength, 0.12);
  const withBloom = setRecipe();
  withBloom.effects = { bloom: { strength: 0.3 } };
  assert.equal(applyBlast(blast(), withBloom).recipe.effects.bloom.strength, 0.3);
});

test('motionBlur takes the shutter the scene already has, and leaves the effects alone when off', () => {
  const withShutter = setRecipe();
  withShutter.effects = { motionBlur: { shutter: 0.02 } };
  assert.equal(applyBlast(blast(), withShutter).recipe.effects.motionBlur.shutter, 0.02);
  const sharp = applyBlast(blast({ motionBlur: false })).recipe;
  assert.equal(sharp.effects.motionBlur.shutter, 0);
  assert.ok(!sharp.environment.localVolumes[0].frames.some(name => name.includes('velocity')));
});

test('a sparks object overrides count, speed and lifetime, and the sparks stay a pure function of the seed', () => {
  const { recipe } = applyBlast(blast({ sparks: { count: 300, speed: [1, 5], lifetime: 1 } }));
  const [sparks] = recipe.particles.systems;
  assert.equal(sparks.type, 'sparks');
  assert.equal(sparks.count, 300);
  assert.deepEqual(sparks.speed, [1, 5]);
  assert.deepEqual(sparks.lifetime, [1, 1]);
  assert.equal(JSON.stringify(applyBlast(blast({ seed: 5 })).recipe), JSON.stringify(applyBlast(blast({ seed: 5 })).recipe));
  const plain = applyBlast(blast({ sparks: false })).recipe.particles.systems[0];
  assert.equal(plain.type, 'emitter');
  assert.equal(plain.count, 700);
});

test('bad sparks and motionBlur values name the field and a valid value', () => {
  const cases = [
    [blast({ sparks: 'yes' }), /sparks.*streaks, specks, none/],
    [blast({ sparks: 3 }), /sparks.*plain object/],
    [blast({ sparks: { count: 0 } }), /sparks\.count.*1 to 2000/],
    [blast({ sparks: { count: 1.5 } }), /sparks\.count/],
    [blast({ sparks: { count: 5000 } }), /sparks\.count/],
    [blast({ sparks: { speed: 500 } }), /sparks\.speed.*0 to 100/],
    [blast({ sparks: { speed: [5, 1] } }), /sparks\.speed.*smaller number first/],
    [blast({ sparks: { lifetime: 0 } }), /sparks\.lifetime.*0\.05 to 5/],
    [blast({ sparks: { color: 1 } }), /sparks\.color/],
    [blast({ motionBlur: 'on' }), /motionBlur.*true.*false/],
  ];
  for (const [operation, pattern] of cases) assert.throws(() => applyBlast(operation), pattern, JSON.stringify(operation));
});

test('the fireball emits by the Blender flame remap, 1500 K to 3000 K, at every size and fuel (#1735)', () => {
  for (const extra of [{ size: 2.5 }, { size: 10 }, { fuel: 'oily' }]) {
    const volume = applyBlast(blast(extra)).recipe.environment.localVolumes[0];
    assert.deepEqual(volume.flameTemperature, { ignition: 1.5, maximum: 3 });
    assert.equal(volume.temperatureScale, 1000);
  }
});

test('the blast dust and rubble sampled at a later time are ranked against a box floor, so no coplanar pair is left (#2054)', () => {
  const recipe = setRecipe();
  delete recipe.physics;
  recipe.nodes = [{ id: 'floor', geometry: 'slab', material: 'stone', translation: [0, -0.05, 0], scale: [6, 0.1, 6] }];
  const { scene } = applyBlast(blast({ start: 0.5, seed: 7, fuel: 'oily', shake: 0.4 }), recipe);
  scene.sampleMotion(1.2);
  const blastParts = scene.parts.filter(part => part.name.startsWith('blast-'));
  assert.ok(blastParts.some(part => part.name === 'blast-dust'), 'the sampled dust part exists');
  const pairs = findCoplanarOverlaps(scene.parts).overlaps.map(overlap => [overlap.first?.name ?? overlap.larger?.name, overlap.second?.name ?? overlap.smaller?.name]);
  assert.deepEqual(pairs, []);
});

test('detail is off by default, a strength fills scale and octaves, and a bad value says what to pass (#1832)', () => {
  const volumeOf = extra => applyBlast(blast(extra)).recipe.environment.localVolumes[0];
  assert.equal('detailNoise' in volumeOf({}), false);
  assert.equal('detailNoise' in volumeOf({ detail: 0 }), false);
  assert.deepEqual(volumeOf({ detail: 0.2 }).detailNoise, { strength: 0.2, scale: 1, octaves: 3 });
  assert.deepEqual(volumeOf({ detail: { strength: 0.35, scale: 2 } }).detailNoise, { strength: 0.35, scale: 2, octaves: 3 });
  assert.throws(() => blastWithDetail(1.5), /detail\.strength.*0.*1/s);
  assert.throws(() => blastWithDetail('rough'), /detail.*a strength from 0 to 1 such as 0\.2/s);
  assert.throws(() => blastWithDetail({ strength: 0.2, octaves: 2.5 }), /detail\.octaves.*whole number from 1 to 5/s);
  assert.throws(() => blastWithDetail({ strength: 0.2, grain: 1 }), /grain/);
  function blastWithDetail(detail) { return applyBlast(blast({ detail })); }
});
