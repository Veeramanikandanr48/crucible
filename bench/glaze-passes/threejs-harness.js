// Runs in the page. Draws one scene file's GLB with three.js the way the #1163 comparison did (MSAA 4, ACES, PCF soft shadows
// on the GLB's lights, PMREM environment from the scene's HDRI) and times whole frames on the GPU, the same way harness.js does.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

const WARMUP_FRAMES = 20;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const ONE_PIXEL = new Uint8Array(4);

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

window.measureThree = async function measureThree({ description, glbUrl, hdriUrl, frames = 200, width = 1280, height = 720 }) {
  const canvas = document.querySelector('#viewport');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = description.exposure ?? 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const context = renderer.getContext();
  const timerExtension = context.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timerExtension) throw new Error('This browser has no EXT_disjoint_timer_query_webgl2.');

  const environmentTexture = await new RGBELoader().loadAsync(hdriUrl);
  environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  scene.environment = pmremGenerator.fromEquirectangular(environmentTexture).texture;
  scene.background = scene.environment;
  const gltf = await new GLTFLoader().loadAsync(glbUrl);
  gltf.scene.traverse(object => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
    if (object.isLight) object.castShadow = true;
  });
  scene.add(gltf.scene);
  const camera = new THREE.PerspectiveCamera(description.frame?.fov ?? 50, width / height, description.frame?.near ?? 0.05, description.frame?.far ?? 2000);
  camera.position.fromArray(description.eye);
  camera.lookAt(new THREE.Vector3().fromArray(description.target));

  const wallMilliseconds = [];
  const gpuMilliseconds = [];
  const pending = [];
  const drain = () => {
    while (pending.length) {
      const query = pending[0];
      if (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) return;
      pending.shift();
      if (!context.getParameter(timerExtension.GPU_DISJOINT_EXT)) gpuMilliseconds.push(context.getQueryParameter(query, context.QUERY_RESULT) / NANOSECONDS_PER_MILLISECOND);
    }
  };
  for (let index = 0; index < WARMUP_FRAMES + frames; index++) {
    const started = performance.now();
    const query = context.createQuery();
    context.beginQuery(timerExtension.TIME_ELAPSED_EXT, query);
    renderer.render(scene, camera);
    context.endQuery(timerExtension.TIME_ELAPSED_EXT);
    pending.push(query);
    context.readPixels(Math.floor(width / 2), Math.floor(height / 2), 1, 1, context.RGBA, context.UNSIGNED_BYTE, ONE_PIXEL);
    if (index >= WARMUP_FRAMES) wallMilliseconds.push(performance.now() - started);
    drain();
  }
  for (let attempt = 0; attempt < 200 && pending.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    drain();
  }
  return {
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    wallMedianMs: Number(median(wallMilliseconds).toFixed(3)),
    gpuTotalMedianMs: Number(median(gpuMilliseconds.slice(WARMUP_FRAMES)).toFixed(3)),
    centerPixel: Array.from(ONE_PIXEL),
    glError: context.getError(),
  };
};
window.harnessReady = true;
