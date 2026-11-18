// What a game recipe needs from the runtime, as pure data checks. startGame loads an optional piece only when a recipe needs it,
// and the web export copies that piece only when the same check says so, so a plain game does not carry the physics engine or the
// texture swap code.

// The body shapes the game physics builds: every baked shape except trimesh. A compound is up to 16 parts (box, ball, capsule,
// cylinder or cone), as in the baked path.
export const GAME_PHYSICS_BODY_SHAPES = Object.freeze(['box', 'ball', 'capsule', 'cylinder', 'cone', 'convex', 'compound']);

/** Why a recipe cannot play physics in a game (the engine is Jolt), or null. */
export function gamePhysicsProblem(recipe) {
  const physics = recipe.physics;
  if (!physics?.bodies?.length) return 'game.physics is true, but the recipe has no physics section with bodies. Add one with set-physics, or set game.physics to false with set-game.';
  if (physics.joints?.length || physics.ragdoll) return 'The game physics engine builds no joints or ragdolls yet. Remove physics.joints and physics.ragdoll, or set game.physics to false with set-game.';
  const unsupported = physics.bodies.find(body => body.shape === 'trimesh');
  if (unsupported) return `Body "${unsupported.node}" has shape ${unsupported.shape}, which the game physics engine does not build. The game physics builds ${GAME_PHYSICS_BODY_SHAPES.join(', ')}. Use "box" for a floor or wall (a fixed body defaults to trimesh) or "convex" for a closed solid.`;
  return null;
}

// A textured part is swapped by replaceParts only once the replace-textured-parts addon is loaded, and the first scene update
// after a pattern or map bake can swap the parts.
export function hasTexturedMaterial(recipe) {
  return (recipe.materials ?? []).some(material => Object.keys(material).some(key => key === 'pattern' || key === 'map' || key.endsWith('Map')));
}

const IDENTITY_TOLERANCE = 1e-6;

function hasIdentityTransform(node) {
  const [x = 0, y = 0, z = 0, w = 1] = node.rotation ?? [];
  const scale = node.scale ?? [1, 1, 1];
  return Math.abs(x) < IDENTITY_TOLERANCE && Math.abs(y) < IDENTITY_TOLERANCE && Math.abs(z) < IDENTITY_TOLERANCE
    && Math.abs(Math.abs(w) - 1) < IDENTITY_TOLERANCE
    && scale.every(component => Math.abs(component - 1) < IDENTITY_TOLERANCE);
}

// The summed translation of the parents above a node. The controller works in world space, so the node's own translation is the
// world position minus this offset. A parent that rotates or scales cannot be undone this way, so it is refused with the fix.
export function parentTranslation(nodes, id, field) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const offset = [0, 0, 0];
  const visited = new Set([id]);
  for (let parent = byId.get(byId.get(id)?.parent); parent && !visited.has(parent.id); parent = byId.get(parent.parent)) {
    visited.add(parent.id);
    if (!hasIdentityTransform(parent)) {
      throw new Error(`${field} "${id}" sits under the parent "${parent.id}", which has a rotation or scale. A game places a player or NPC in world space, so give "${parent.id}" only a translation, or use a node whose parents have no rotation or scale.`);
    }
    for (let axis = 0; axis < 3; axis++) offset[axis] += parent.translation?.[axis] ?? 0;
  }
  return offset;
}
