// Runs in the page of withWebGpuPage: an L-shaped closed room (a hidden part) over a floor, filled with a glowing mesh volume (#2004), path traced on the CPU and on the
// WebGPU tracer with the same seed, so a test and an evidence script compare the two. Returns the linear pixels of each backend and the seconds each took.
export async function renderMeshVolumeBothBackends({ width, height, samples, volumeExtra = {} }) {
  const { box: makeBox } = await import('/src/geometry.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  // Three unit squares in x and z (the notch is x in 1..2, z in 1..2), extruded in y from 0 to 1.
  const outline = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 1]];
  const positions = [];
  for (const height01 of [0, 1]) for (const [x, z] of outline) positions.push(x, height01, z);
  const indices = [];
  const top = outline.length;
  for (const [firstCorner, secondCorner, thirdCorner, fourthCorner] of [[0, 1, 4, 7], [1, 2, 3, 4], [7, 4, 5, 6]]) {
    indices.push(firstCorner, secondCorner, thirdCorner, firstCorner, thirdCorner, fourthCorner, top + firstCorner, top + thirdCorner, top + secondCorner, top + firstCorner, top + fourthCorner, top + thirdCorner);
  }
  for (let corner = 0; corner < outline.length; corner++) {
    const next = (corner + 1) % outline.length;
    indices.push(corner, next, top + next, corner, top + next, top + corner);
  }
  const geometry = { positions: new Float32Array(positions), indices: new Uint32Array(indices), normals: new Float32Array(positions.length) };
  const roomMatrix = new Float32Array([3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, -3, 0.05, -3, 1]);
  const floorMatrix = new Float32Array([10, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 10, 0, 0, 0, 0, 1]);
  const material = { color: [0.5, 0.5, 0.5] };
  const parts = [{ name: 'floor', geometry: makeBox(0, 1), matrix: floorMatrix, material }, { name: 'room', visible: false, geometry, matrix: roomMatrix, material }];
  const volume = { shape: 'mesh', part: 'room', fit: 'mesh', density: 1.2, falloff: 0, steps: 24, absorption: [0.7, 0.8, 1], emission: [0.9, 0.45, 0.15], emissionStrength: 1.5, ...volumeExtra };
  const map = { width: 4, height: 2, channels: 3, data: new Float32Array(24).fill(0.15), intensity: 1, rotation: 0 };
  const environment = { localVolumes: [volume], keyColor: [3, 3, 3], lightDirection: [1, 0.6, 0.3], map };
  const camera = { eye: [0, 6, 7.5], target: [0, 0.7, 0], fov: 45 };
  const result = {};
  for (const backend of ['cpu', 'webgpu']) {
    const started = performance.now();
    const image = await renderPathTracedImage({ parts, environment, camera }, { width, height, samples, bounces: 3, seed: 7, backend, denoiser: 'none', threads: 1 });
    result[backend] = { linear: Array.from(image.linear), seconds: (performance.now() - started) / 1000, ignored: image.report?.ignored ?? [] };
  }
  return result;
}
