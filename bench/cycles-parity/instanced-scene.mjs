// The instanced trace scene of a bench scene for the native cycles kernel: copies of one geometry stay instances, and a part that hides
// from some ray kinds gets those visibility bits cleared (buildTraceScene reads `rayVisibility`, #1054). The scene is built with the
// native triangle bound (#1041), so a scene above the 400,000 unique triangles of the CPU and WebGL paths, such as the Classroom, packs directly.
// A normal-mapped part under a non-conformal matrix is an instance too (#1844), as in a native render job
// (exportNativeSceneTables in scripts/native-bake-page.js), so Cook shrinks the tilt the way Cycles does.
import { MAX_NATIVE_TRACE_TRIANGLES } from '../../src/path-tracer-scene.js';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';

export function buildInstancedTraceScene(parts, environment) {
  const scene = buildTraceSceneWithManyLights(parts, environment, { instancing: true, instanceNormalMappedParts: true, maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES });
  if (!scene.instances) {
    throw new RangeError('The scene has no shared geometry and was flattened.');
  }
  return scene;
}

// The trace scene a native render job builds for the "cycles" kernel: the same options as exportNativeSceneTables, so a scene
// that has nothing to instance stays flattened and a normal-mapped part under a non-conformal matrix is an instance.
export function buildCookJobTraceScene(parts, environment, { instancing }) {
  return buildTraceSceneWithManyLights(parts, environment, { instancing, instanceNormalMappedParts: true, maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES });
}
