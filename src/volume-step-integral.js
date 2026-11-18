// The light a ray picks up across one march step of a glowing volume (#1894). A step of width w with extinction k per unit length dims
// the light behind it by exp(-k w), and the glow it adds is emission * w * (1 - exp(-tau)) / tau with tau = k w: the exact integral of
// the glow dimmed by the part of the step already crossed. Weighting by the transmittance at the start of the step (weight 1) counts
// each step's light too bright, by about 25 percent at tau 0.44, so a dense volume came out brighter and wider than the real integral.
// The rasterizer's shape and grid marches, the CPU path tracer's and the WebGPU path tracer's all use this one weight.

/** Below this optical depth the weight comes from its series, 1 - tau / 2 + tau^2 / 6, because (1 - exp(-tau)) / tau loses its digits. */
export const STEP_INTEGRAL_SERIES_LIMIT = 1e-3;

/** The weight (1 - exp(-tau)) / tau of one channel for a step of optical depth `opticalDepth`; 1 for no extinction, tending to 0 for a very dense step. */
export function stepIntegralWeight(opticalDepth) {
  if (opticalDepth < STEP_INTEGRAL_SERIES_LIMIT) return 1 - opticalDepth * 0.5 + opticalDepth * opticalDepth / 6;
  return (1 - Math.exp(-opticalDepth)) / opticalDepth;
}

/** The same weight for the rasterizer's GLSL, per channel. */
export const STEP_INTEGRAL_GLSL = `vec3 volumeStepIntegral(vec3 opticalDepth) {
  vec3 series = vec3(1.0) - opticalDepth * 0.5 + opticalDepth * opticalDepth * (1.0 / 6.0);
  vec3 exact = (vec3(1.0) - exp(-opticalDepth)) / max(opticalDepth, vec3(${STEP_INTEGRAL_SERIES_LIMIT}));
  return mix(exact, series, vec3(lessThan(opticalDepth, vec3(${STEP_INTEGRAL_SERIES_LIMIT}))));
}
`;

/** The same weight for the WebGPU path tracer's WGSL, per channel. */
export const STEP_INTEGRAL_WGSL = `fn volumeStepIntegral(opticalDepth: vec3<f32>) -> vec3<f32> {
  let series = vec3<f32>(1.0) - opticalDepth * 0.5 + opticalDepth * opticalDepth * (1.0 / 6.0);
  let exact = (vec3<f32>(1.0) - exp(-opticalDepth)) / max(opticalDepth, vec3<f32>(${STEP_INTEGRAL_SERIES_LIMIT}));
  return select(exact, series, opticalDepth < vec3<f32>(${STEP_INTEGRAL_SERIES_LIMIT}));
}
`;
