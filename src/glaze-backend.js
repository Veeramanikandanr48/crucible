// The Glaze backend boundary (#901): what the real-time renderer asks of a graphics API (see glaze-backend-webgl2.js for the list of calls).
// WebGL2 is the only implementation today. The renderer's frame core calls the backend instead of the raw context; pass files not yet
// ported still use `backend.context` directly.

import { WebGL2GlazeBackend } from './glaze-backend-webgl2.js';

/** Opens the canvas with the one backend there is; WebGL2 stays the fallback once another backend exists. */
export function createGlazeBackend(canvas, options = {}) {
  return WebGL2GlazeBackend.create(canvas, options);
}
