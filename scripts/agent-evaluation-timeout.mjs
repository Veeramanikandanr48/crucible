// How long one preview call may run before the runtime gives up on it (#1768, #1050).

/**
 * The first draw of a grid volume compiles the local-volume composite shader in the browser's graphics driver (ANGLE). That took 5 s warm and 15 s
 * after idle on a free GPU, and 23 to 32 s on a loaded one, so a call that adds a grid volume gets this many times a plain call. The compile is the
 * driver's own and cannot be shortened from here.
 */
export const GRID_VOLUME_TIMEOUT_FACTOR = 2;

/** True when the recipe's environment holds a local volume of shape "grid". */
export function recipeHasGridVolume(recipe) {
  const volumes = recipe?.environment?.localVolumes;
  return Array.isArray(volumes) && volumes.some(volume => volume?.shape === 'grid');
}

/** True when an apply adds an explosion, whose fireball is a grid volume. */
export function operationsAddGridVolume(operations) {
  return Array.isArray(operations) && operations.some(operation => operation?.type === 'add-explosion');
}

/** A bake has its own longer deadline and wins; otherwise a call that adds a grid volume gets the longer one. */
export function previewCallTimeoutMs({ bakes, addsGridVolume, plainTimeoutMs, bakeTimeoutMs }) {
  if (bakes) return bakeTimeoutMs;
  return addsGridVolume ? GRID_VOLUME_TIMEOUT_FACTOR * plainTimeoutMs : plainTimeoutMs;
}
