// One name for a glTF animation clip, wherever an agent reads it: the catalog, the scene and the GLB export.

/** The name an unnamed clip gets. The glTF decoder, the catalog and the export all use it. */
export function fallbackClipName(clipIndex) {
  return `animation_${clipIndex}`;
}

/** The clip's own name, or its fallback name when the file leaves it empty. */
export function clipDisplayName(animation, clipIndex) {
  const name = animation?.name;
  return typeof name === 'string' && name !== '' ? name : fallbackClipName(clipIndex);
}

/**
 * The index of the clip a caller means, given its index or its name.
 * Throws a RangeError that lists the valid indexes and names when nothing matches, and one that lists the indexes
 * when a name is shared by several clips.
 */
export function resolveClipIndex(animations, clip, field = 'clip') {
  const names = animations.map(clipDisplayName);
  if (typeof clip === 'string') {
    const matches = names.flatMap((name, index) => (name === clip ? [index] : []));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new RangeError(`${field} "${clip}" names ${matches.length} clips. Pass one of their indexes: ${matches.join(', ')}.`);
    throw new RangeError(`${field} "${clip}" does not exist. ${availableClips(names)}`);
  }
  if (!Number.isInteger(clip) || clip < 0 || clip >= animations.length) {
    throw new RangeError(`${field} ${clip} does not exist. ${availableClips(names)}`);
  }
  return clip;
}

function availableClips(names) {
  if (names.length === 0) return 'The asset has no clips.';
  return `Pass an index or a name: ${names.map((name, index) => `${index} "${name}"`).join(', ')}.`;
}
