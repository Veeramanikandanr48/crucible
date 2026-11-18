// Placing a catalog GLB by file name. The SHA-256 asset id changes on every re-export of a file, its name does not, so a
// recipe may write `asset: { name: "sheep_body.glb" }`. The MCP server resolves the name against the catalog when the call
// arrives; this module only rewrites the parsed recipe, so the scene core never sees a name.
import { invalidField } from './field-error.js';
import { visitPlacements } from './agent-scene-assets.js';

/** Whether a recipe or edit list has a placement that names its catalog file instead of its id. */
export function namesCatalogFiles(value) {
  let found = false;
  visitPlacements(value, placement => {
    if (placement.name !== undefined) found = true;
  });
  return found;
}

/**
 * Turns every placement that names its catalog file into the pinned form (`asset: { id }`), in place, so the scene, its
 * snapshots and its render jobs only ever hold the content hash. `resolveName` maps a file name to its asset id or throws.
 * Call it on a recipe or edit list the host has just parsed.
 */
export function resolveAssetPlacementNames(value, resolveName) {
  visitPlacements(value, placement => {
    if (placement.name === undefined) return;
    if (placement.id !== undefined) {
      throw invalidField('asset', 'both id and name', 'exactly one of id (the pinned SHA-256) or name (the catalog file name), such as { "name": "sheep_body.glb" }', TypeError);
    }
    placement.id = resolveName(placement.name);
    delete placement.name;
  });
}

// A texture sequence by catalog name: `map: { sequence: { catalog: "frame_####.png", fps } }` stands for the frames of a long
// numbered folder. The host swaps it for the frame IDs, so the scene, its snapshots and its render jobs only hold the pinned hashes.

function visitMapSequences(value, visit, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) visitMapSequences(item, visit, depth + 1);
    return;
  }
  const sequence = value.map?.sequence;
  if (sequence && typeof sequence === 'object' && !Array.isArray(sequence)) visit(sequence);
  for (const child of Object.values(value)) visitMapSequences(child, visit, depth + 1);
}

/** Whether a recipe or edit list has a `map.sequence` that names a catalog sequence instead of listing frames. */
export function namesCatalogSequences(value) {
  let found = false;
  visitMapSequences(value, sequence => {
    if (sequence.catalog !== undefined) found = true;
  });
  return found;
}

/**
 * Replaces `map.sequence.catalog` with `frames` (the asset IDs in frame order), in place. `resolveSequence` maps a catalog
 * sequence pattern to its frame IDs or throws.
 */
export async function resolveCatalogSequenceNames(value, resolveSequence) {
  const sequences = [];
  visitMapSequences(value, sequence => {
    if (sequence.catalog !== undefined) sequences.push(sequence);
  });
  for (const sequence of sequences) {
    if (sequence.frames !== undefined) {
      throw invalidField('map.sequence', 'both frames and catalog', 'exactly one of frames (asset IDs) or catalog (the pattern of a catalog sequence), such as { "catalog": "frame_####.png", "fps": 24 }', TypeError);
    }
    sequence.frames = await resolveSequence(sequence.catalog);
    delete sequence.catalog;
  }
}
