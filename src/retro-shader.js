import { invalidField } from './field-error.js';
import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';

// Retro look of a raster material (the PlayStation 1 look): `retro: { vertexSnap: [width, height], affineUV: true }`.
// vertexSnap rounds every vertex to a grid of width by height cells across the screen, so vertices jitter as the camera
// moves. affineUV interpolates texture coordinates without perspective correction, so textures swim across large
// triangles. Only the raster renderer reads it; the path tracer draws the material as usual.
// The GLSL lives here, outside shaders.js, so a scene without a retro material never downloads or compiles it: the
// renderer asks for the `retro` feature only when a part has `retro`, and importing this module (or loading it through
// loadAgentSceneModules) registers it. A zero grid leaves a batch unsnapped. Passing uv * w beside w makes the
// perspective-correct interpolation cancel, so the fragment divides to a plain affine uv.

export const RETRO_SNAP_LIMITS = Object.freeze({ minimum: 16, maximum: 4096 });
const RETRO_FIELDS = ['vertexSnap', 'affineUV'];

const RETRO_VERTEX_DECLARATIONS = `uniform vec3 retro;
out vec3 affineUV;
`;

const RETRO_VERTEX_TAIL = `  if (retro.x > 0.0 && gl_Position.w > 0.0) {
    vec2 halfCells = retro.xy * 0.5;
    gl_Position.xy = round(gl_Position.xy / gl_Position.w * halfCells) / halfCells * gl_Position.w;
  }
  float affineWeight = retro.z > 0.5 ? gl_Position.w : 1.0;
  affineUV = vec3(uv * affineWeight, affineWeight);
`;

const RETRO_FRAGMENT_COORDINATES = `in vec3 affineUV;
#define textureUV (affineUV.xy / affineUV.z)
`;

registerShaderFeatureCode('retro', Object.freeze({
  head: RETRO_VERTEX_DECLARATIONS,
  tail: RETRO_VERTEX_TAIL,
  uv: RETRO_FRAGMENT_COORDINATES,
}));

// Sets the snap grid and the affine switch of the batch about to draw; a batch without retro turns both off.
const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  if (!renderer.shaderFeatures.has('retro')) return;
  const { context, uniforms } = renderer;
  uniforms.retro ??= context.getUniformLocation(renderer.program, 'retro');
  context.uniform3f(uniforms.retro, ...(batch.retro?.vertexSnap ?? [0, 0]), batch.retro?.affineUV ? 1 : 0);
};

function normalizeVertexSnap(value) {
  const { minimum, maximum } = RETRO_SNAP_LIMITS;
  const valid = Array.isArray(value) && value.length === 2 && value.every(cells => Number.isInteger(cells) && cells >= minimum && cells <= maximum);
  if (!valid) {
    throw invalidField('retro.vertexSnap', value, `two whole numbers [width, height] from ${minimum} to ${maximum}, such as [160, 120]`, TypeError);
  }
  return Object.freeze([...value]);
}

/** Validates a material `retro` field and returns a frozen copy that holds only the options that were set. */
export function normalizeMaterialRetro(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField('retro', value, 'an object, such as { vertexSnap: [160, 120], affineUV: true }', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!RETRO_FIELDS.includes(key)) {
      throw invalidField(`retro.${key}`, value[key], `one of the fields ${RETRO_FIELDS.join(', ')}; remove ${key}`, TypeError);
    }
  }
  const result = {};
  if (value.vertexSnap !== undefined) result.vertexSnap = normalizeVertexSnap(value.vertexSnap);
  if (value.affineUV !== undefined) {
    if (typeof value.affineUV !== 'boolean') throw invalidField('retro.affineUV', value.affineUV, 'true or false', TypeError);
    if (value.affineUV) result.affineUV = true;
  }
  if (result.vertexSnap === undefined && result.affineUV === undefined) {
    throw invalidField('retro', value, 'at least one of vertexSnap [160, 120] or affineUV true; remove retro for the plain look', TypeError);
  }
  return Object.freeze(result);
}
