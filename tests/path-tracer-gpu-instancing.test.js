import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { box, icoSphere } from '../src/geometry.js';
import { packInstancedScene } from '../src/path-tracer-gpu-instance-pack.js';
import { packMaterials, packAtlas, packNodes, packTriangles } from '../src/path-tracer-gpu-pack.js';
import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';
import { buildTraceScene, buildTraceSceneForDevice, isInstancedScene, uniqueTriangleCount } from '../src/path-tracer-scene.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

// Issue #2239: the WebGL2 path tracer keeps copies of one mesh as instances (one triangle table and bottom-level BVH per mesh, a
// top-level BVH over the copies) instead of flattening every copy into the triangle table.

const SPHERE = icoSphere(2);
const SPHERE_TRIANGLES = SPHERE.indices.length / 3;
const INSTANCING_MODULE = { supportsInstancing: true, gpuTriangleLimit: () => 4 * SPHERE_TRIANGLES };
const FLATTENING_MODULE = { gpuTriangleLimit: () => 4 * SPHERE_TRIANGLES };

function translation(x, y = 0, z = 0) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function copies(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `copy-${index}`,
    geometry: SPHERE,
    matrix: translation(index * 3, 0.5, -index),
    material: { color: [0.2 + index * 0.1, 0.5, 0.7], roughness: 0.4 },
  }));
}

function digest(...tables) {
  const hash = createHash('sha256');
  for (const table of tables) hash.update(Buffer.from(table.data.buffer));
  return hash.digest('hex');
}

test('a scene that shares a mesh packs the mesh once, with one record per copy', () => {
  const scene = buildTraceScene(copies(2), {}, { instancing: true, gpuTriangleLimit: 4 * SPHERE_TRIANGLES });
  assert.equal(isInstancedScene(scene), true);
  const packed = packInstancedScene(scene);
  const flat = packTriangles(buildTraceScene(copies(2), {}), { secondUvSet: true });
  assert.equal(packed.triangleCount, SPHERE_TRIANGLES);
  assert.equal(uniqueTriangleCount(scene), SPHERE_TRIANGLES);
  assert.ok(packed.triangles.height < flat.height, 'the instanced triangle table holds one copy of the mesh, the flattened one two');

  const recordFloats = 7 * 4;
  const rows = [0, 1].map(slot => packed.instances.data.subarray(slot * recordFloats, (slot + 1) * recordFloats));
  assert.equal(rows[0][24], rows[1][24], 'both copies start at the same bottom-level root');
  assert.deepEqual(rows.map(row => row[25]).sort(), [0, 1], 'each copy keeps its own material');
  const translations = rows.map(row => -row[3]).sort((first, second) => first - second);
  assert.deepEqual(translations, [0, 3], 'the world to mesh matrix undoes the placement');
  assert.ok(packed.topRoot > 0, 'the top-level BVH follows the bottom-level one');
});

test('the triangle limit of a GPU scene counts a shared mesh once', async () => {
  const nineCopies = copies(9);
  const flattened = buildTraceSceneForDevice(nineCopies, {}, FLATTENING_MODULE);
  await assert.rejects(flattened, { name: 'RangeError', message: new RegExp(`got ${9 * SPHERE_TRIANGLES}`) });
  const scene = await buildTraceSceneForDevice(nineCopies, {}, INSTANCING_MODULE);
  assert.equal(isInstancedScene(scene), true);
  assert.equal(scene.instances.length, 9);
  assert.equal(uniqueTriangleCount(scene), SPHERE_TRIANGLES);
});

test('a mesh that is not shared still holds its own triangles against the limit', async () => {
  const otherMesh = box(0.1, 4);
  const different = [{ ...copies(1)[0] }, { ...copies(2)[1], geometry: otherMesh }];
  const tightModule = { supportsInstancing: true, gpuTriangleLimit: () => SPHERE_TRIANGLES };
  await assert.rejects(buildTraceSceneForDevice(different, {}, tightModule), { name: 'RangeError', message: new RegExp(`got ${SPHERE_TRIANGLES + otherMesh.indices.length / 3}`) });
});

// The digest of the node, triangle (ten and nine texels a triangle) and material tables of the scene below, taken on origin/main before instancing existed.
const UNSHARED_SCENE_DIGEST = '42fdf6ac1ab280002a7be789762e56ec0bff28d0407b4064dd91891bcaf1baf1';

test('a scene without shared geometry flattens and packs the same bytes with or without the instancing module', async () => {
  const parts = [
    { name: 'a', geometry: SPHERE, matrix: translation(0, 0.5), material: { color: [0.2, 0.5, 0.7], roughness: 0.4 } },
    { name: 'b', geometry: box(0.1, 4), matrix: translation(3, 0.5), material: { color: [0.3, 0.5, 0.7], roughness: 0.4 } },
  ];
  const options = { gpuTriangleLimit: 1_000_000 };
  const plain = buildTraceScene(parts, {}, options);
  const opted = await buildTraceSceneForDevice(parts, {}, { supportsInstancing: true, gpuTriangleLimit: () => 1_000_000 });
  assert.equal(isInstancedScene(opted), false);
  const packOf = scene => {
    const atlas = packAtlas(scene.materials);
    return [packNodes(scene.bvh), packTriangles(scene, { secondUvSet: true }), packTriangles(scene), packMaterials(scene.materials, atlas, scene.shadowOnlyParts)];
  };
  assert.equal(digest(...packOf(opted)), digest(...packOf(plain)));
  assert.equal(digest(...packOf(plain)), UNSHARED_SCENE_DIGEST, 'the tables are the bytes origin/main packed');
  assert.deepEqual(Array.from(opted.positions), Array.from(plain.positions));
  assert.deepEqual(Array.from(opted.triangleMaterial), Array.from(plain.triangleMaterial));
});

test('the flattened kernel does not read the instance tables, and the instanced one does', () => {
  assert.doesNotMatch(buildFragmentSource({}), /uInstances|uTopRoot/);
  assert.match(buildFragmentSource({ instanced: true }), /uniform sampler2D uInstances;/);
  assert.match(buildFragmentSource({ instanced: true, texelBake: true }), /traceInstance/);
});

test('the instanced kernel keeps every texture fetch free of another fetch in its index', () => {
  const source = buildFragmentSource({ instanced: true, hasSubsurface: true });
  const fetchCall = /fetch(?:Data|Scalar)\(/g;
  let match;
  while ((match = fetchCall.exec(source)) !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    const argumentStart = cursor;
    while (depth > 0 && cursor < source.length) {
      if (source[cursor] === '(') depth++;
      if (source[cursor] === ')') depth--;
      cursor++;
    }
    assert.doesNotMatch(source.slice(argumentStart, cursor - 1), /fetch(?:Data|Scalar)\(/);
  }
});

// Runs in the page: the same scene traced from flattened triangles and from instances, on the WebGL2 tracer.
async function traceBothWays() {
  const { icoSphere: sphere, box: cube } = await import('/src/geometry.js');
  const { buildTraceScene: build, uniqueTriangleCount: count } = await import('/src/path-tracer-scene.js');
  const { createCamera, normalizePathTracerOptions } = await import('/src/path-tracer.js');
  const gpuModule = await import('/src/path-tracer-gpu.js');
  const shared = sphere(2);
  const place = (x, y, z, scale, extra = {}) => [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1].map((value, index) => extra[index] ?? value);
  const rotated = [0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0, 0, 0, 1, 0, 0.4, 1.2, -0.2, 1];
  const parts = [
    { name: 'floor', geometry: cube(0, 1), matrix: [8, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 8, 0, 0, -0.1, 0, 1], material: { color: [0.6, 0.6, 0.6] } },
    { name: 'left', geometry: shared, matrix: place(-1.4, 0.6, 0, 0.6), material: { color: [0.9, 0.2, 0.2], roughness: 0.3 } },
    { name: 'middle', geometry: shared, matrix: rotated.map((value, index) => (index % 5 === 0 && index < 10 ? value * 0.7 : value)), material: { color: [0.2, 0.8, 0.3], metallic: 1, roughness: 0.2 } },
    { name: 'right', geometry: shared, matrix: place(1.5, 0.5, 0.3, 0.5, { 0: -0.5 }), material: { color: [0.2, 0.3, 0.9], roughness: 0.6 } },
  ];
  const environment = { keyColor: [1, 0.95, 0.9], lightDirection: [0.4, 1, 0.3], keyIntensity: 3, pointLights: [{ position: [0, 3, 1], color: [1, 1, 1], intensity: 10, radius: 0.1 }] };
  const camera = { eye: [0, 1.8, 5], target: [0, 0.6, 0], fov: 50 };
  const width = 48;
  const height = 32;
  const options = normalizePathTracerOptions({ width, height, samples: 8, bounces: 3, seed: 7, backend: 'gpu', denoiser: 'none', threads: 1 });
  const view = createCamera(camera, width, height);
  const limit = 1_000_000;
  const flat = build(parts, environment, { gpuTriangleLimit: limit });
  const instanced = build(parts, environment, { gpuTriangleLimit: limit, instancing: true });
  const flatImage = await gpuModule.traceOnGpu(flat, view, options, () => {});
  const instancedImage = await gpuModule.traceOnGpu(instanced, view, options, () => {});
  // Every other kernel variant reads the instance tables through the same helpers; each must still compile.
  gpuModule.getKernel(true, false, { instanced: true });
  gpuModule.getKernel(false, true, { instanced: true });
  gpuModule.getKernel(false, false, { instanced: true, lightSelection: 'tree', samplingPattern: 'blue-noise-first' });
  let squared = 0;
  let sum = 0;
  for (let index = 0; index < flatImage.color.length; index++) {
    squared += (flatImage.color[index] - instancedImage.color[index]) ** 2;
    sum += flatImage.color[index];
  }
  return {
    rmse: Math.sqrt(squared / flatImage.color.length),
    mean: sum / flatImage.color.length,
    flatTriangles: count(flat),
    instancedTriangles: count(instanced),
    instancedFlag: Array.isArray(instanced.instances),
  };
}

test('on the WebGL2 tracer an instanced scene renders what the flattened scene renders', { timeout: 240_000 }, async context => {
  await withDevServerPage(context, async page => {
    const result = await page.evaluate(traceBothWays);
    assert.equal(result.instancedFlag, true);
    assert.ok(result.instancedTriangles < result.flatTriangles);
    assert.ok(result.mean > 0.05, `the picture is not black (mean ${result.mean})`);
    assert.ok(result.rmse < result.mean * 0.001, `instanced and flattened pictures match within noise (rmse ${result.rmse}, mean ${result.mean})`);
  });
});
