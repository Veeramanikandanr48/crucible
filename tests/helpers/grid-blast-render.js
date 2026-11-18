// Runs in the page of withWebGpuPage: a small baked gas blast (the #1735 grid, src/gas-sim.js) as a grid volume over a floor, path traced on the CPU and on the
// WebGPU tracer with the same seed, so a test and an evidence script compare the two. Returns the linear pixels of each backend and the seconds each took.
export async function renderBlastBothBackends({ resolution, width, height, samples, volumeTime, volumeShutter, volumeExtra = {} }) {
  const { box: makeBox } = await import('/src/geometry.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const { bakeGasSimToGrids, GAS_SIM_TEMPERATURE_UNIT } = await import('/src/gas-sim.js');
  const frames = bakeGasSimToGrids({ resolution, frames: 6, fps: 24, seed: 3, velocity: true }, 'blast-1785');
  const volume = { shape: 'grid', frames, fps: 24, center: [0, 4, 0], size: [8, 8, 8], density: 4, emission: [1, 0.45, 0.12], emissionStrength: 14, temperatureScale: GAS_SIM_TEMPERATURE_UNIT, blackbodyIntensity: 0.3, scatter: 0.4, ...volumeExtra };
  const matrix = new Float32Array([16, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 16, 0, 0, 0, 0, 1]);
  const parts = [{ name: 'floor', geometry: makeBox(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } }];
  const map = { width: 4, height: 2, channels: 3, data: new Float32Array(24).fill(0.15), intensity: 1, rotation: 0 };
  const environment = { localVolumes: [volume], keyColor: [3, 3, 3], lightDirection: [1, 0.6, 0.3], map, volumeTime, volumeShutter };
  const camera = { eye: [0, 3.5, 13], target: [0, 3, 0], fov: 45 };
  const result = {};
  for (const backend of ['cpu', 'webgpu']) {
    const started = performance.now();
    const image = await renderPathTracedImage({ parts, environment, camera }, { width, height, samples, bounces: 3, seed: 7, backend, denoiser: 'none', threads: 1 });
    result[backend] = { linear: Array.from(image.linear), seconds: (performance.now() - started) / 1000, gpu: image.report.gpu ?? null, ignored: image.report.ignored };
  }
  return result;
}
