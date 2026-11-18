import { after, before } from 'node:test';
// Rooms shared by the agent-bake test files.

export function closedRoom(extra = {}) {
  const box = (id, translation, scale, material) => ({ id, geometry: 'box', material, translation, scale });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [
      { id: 'white', color: [0.8, 0.8, 0.8], roughness: 0.9 },
      { id: 'lamp', color: [1, 1, 1], emission: 2 },
    ],
    nodes: [
      box('floor', [0, -0.05, 0], [4, 0.1, 4], 'white'),
      box('ceiling', [0, 3.05, 0], [4, 0.1, 4], 'white'),
      box('back', [0, 1.5, -2.05], [4.2, 3.2, 0.1], 'white'),
      box('front', [0, 1.5, 2.05], [4.2, 3.2, 0.1], 'white'),
      box('left', [-2.05, 1.5, 0], [0.1, 3.2, 4.2], 'white'),
      box('right', [2.05, 1.5, 0], [0.1, 3.2, 4.2], 'white'),
      box('block', [-0.7, 0.6, -0.4], [1.2, 1.2, 1.2], 'white'),
      box('bulb', [0.9, 2.5, 0.6], [0.2, 0.2, 0.2], 'lamp'),
    ],
    camera: { eye: [0, 1.5, 1.9], target: [0, 1.4, -2], fov: 70, near: 0.05, far: 20 },
    environment: { pointLights: [{ position: [0, 2.7, 0], intensity: 14, radius: 0.1 }], keyIntensity: 0, fillIntensity: 0 },
    bake: { preset: 'draft' },
    ...extra,
  };
}

export function closedRoomWithoutBake() {
  const { bake, ...recipe } = closedRoom();
  return recipe;
}

export function lightmapBytes(part) {
  return Buffer.from(part.material.emissiveMap.image.data ?? part.material.emissiveMap.image.bytes);
}

export function roomLitBy(environment) {
  return closedRoom({ environment: { ...environment, keyIntensity: 0, fillIntensity: 0 } });
}

export function lightmapBytesOf(scene, name) {
  return lightmapBytes(scene.parts.find(part => part.name === name));
}

export function largeRoom(bake) {
  const recipe = closedRoom({ bake });
  recipe.environment.spotLights = [{ position: [0, 2.8, 0], direction: [0, -1, 0], angle: 1, intensity: 20 }];
  for (let index = 0; index < 48; index++) {
    const column = index % 8;
    const row = Math.floor(index / 8);
    recipe.nodes.push({ id: `crate-${index}`, geometry: 'box', material: 'white', translation: [-1.75 + column * 0.5, 0.3, -1.7 + row * 0.6], scale: [0.4, 0.6, 0.4] });
  }
  return recipe;
}

export function clothRoom() {
  const recipe = closedRoom({ cloth: { duration: 2, sheets: [{ node: 'flag', pin: ['top'] }] } });
  recipe.geometries.push({ id: 'sheet', type: 'grid', segments: 8 });
  recipe.nodes.push({ id: 'flag', geometry: 'sheet', material: 'white', translation: [0.5, 2, 0], scale: [1, 1, 1] });
  return recipe;
}

/**
 * Stops the clock the light bake reads for its maxSeconds cap while the tests of the calling file run. A bake that takes a second on
 * a quiet machine can take twenty on a loaded CI runner and trip the cap, and these tests check what the bake produces, not how fast it
 * runs. A file that tests the cap itself must not call this.
 */
export function freezeBakeClockForFile() {
  const realNow = performance.now;
  before(() => {
    performance.now = () => 0;
  });
  after(() => {
    performance.now = realNow;
  });
}

/**
 * The large room with every size and distance 300 times as large, plus 30 large crates: it needs more than the million texels
 * a bake takes even at 1 texel per unit, so no samples or bounces setting fits it.
 */
export function oversizedRoom(bake) {
  const recipe = largeRoom(bake);
  recipe.nodes = recipe.nodes.map(node => ({
    ...node,
    ...(node.scale ? { scale: node.scale.map(side => side * 300) } : {}),
    ...(node.translation ? { translation: node.translation.map(value => value * 300) } : {}),
  }));
  for (let index = 0; index < 30; index++) {
    recipe.nodes.push({ id: `hangar-${index}`, geometry: 'box', material: 'white', translation: [-400 + (index % 10) * 80, 60, -400 + Math.floor(index / 10) * 80], scale: [60, 120, 60] });
  }
  return recipe;
}

/** The scene_apply operations that turn a scene built from largeRoom into oversizedRoom: the same nodes, resized and moved, and the added crates. */
export function growToOversizedOperations(bake) {
  const small = new Set(largeRoom(bake).nodes.map(node => node.id));
  return oversizedRoom(bake).nodes.map(node => (small.has(node.id)
    ? { type: 'set-node', id: node.id, translation: node.translation, scale: node.scale }
    : { type: 'add-node', node }));
}

/** The scene_apply operations that undo growToOversizedOperations. */
export function shrinkFromOversizedOperations(bake) {
  const small = new Map(largeRoom(bake).nodes.map(node => [node.id, node]));
  return oversizedRoom(bake).nodes.map(node => (small.has(node.id)
    ? { type: 'set-node', id: node.id, translation: small.get(node.id).translation, scale: small.get(node.id).scale }
    : { type: 'remove-node', id: node.id }));
}
