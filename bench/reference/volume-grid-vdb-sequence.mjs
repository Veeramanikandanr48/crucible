// An animated grid volume (#1045): a converted VDB sequence on a round diorama, drawn by the rasterizer.
// node bench/reference/volume-grid-vdb-sequence.mjs <grid folder> <output folder> [--width 1920] [--height 1080] [--fps 30] [--repeats 5] [--clip] [--voxel 0.05]
// It prints milliseconds per frame (median, p95, worst) over the whole sequence in two passes: the frame changes on every draw
// (one texSubImage3D upload each) and a held frame (no upload). With --clip it also writes frame_0000.png, frame_0001.png, ... to the output folder.
// Chrome comes from CHROME_PATH; on a Linux GPU box pass CHROME_ARGS="--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox".
// The grids come from `uv run --no-project --with numpy --with blosc scripts/vdb-to-grid.py "<sim>/*.vdb" <folder>/blast --sequence`.
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const positional = process.argv.slice(2).filter((argument, index, list) => !argument.startsWith('--') && !(index > 0 && list[index - 1].startsWith('--') && list[index - 1] !== '--clip'));
const [gridFolder, outputFolder] = positional;
if (!gridFolder || !outputFolder) throw new Error('usage: node bench/reference/volume-grid-vdb-sequence.mjs <grid folder> <output folder> [--width 1920] [--height 1080] [--fps 30] [--repeats 5] [--clip] [--voxel 0.05]');
const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const writeClip = process.argv.includes('--clip');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_ARGS = (process.env.CHROME_ARGS ?? '--enable-webgl --ignore-gpu-blocklist --use-angle=d3d11 --enable-gpu').split(' ');
const options = { width: option('width', 1920), height: option('height', 1080), fps: option('fps', 30), repeats: option('repeats', 5), voxelMetres: option('voxel', 0.05), writeClip };
const gridNames = readdirSync(gridFolder).filter(name => name.endsWith('.67vg')).sort();
if (gridNames.length === 0) throw new Error(`No .67vg files in ${gridFolder}. Convert a VDB sequence with scripts/vdb-to-grid.py --sequence first.`);

// Runs in the page. The scene is the "Slow-motion explosion" shot of #1993: a round slab on a plinth, a high oblique camera, no sky.
async function drawSequence({ baseUrl, gridNames, width, height, fps, repeats, voxelMetres, writeClip }) {
  const { cylinder } = await import('/src/geometry.js');
  const { CrucibleRenderer } = await import('/src/renderer.js');
  const { decodeVolumeGrid, registerVolumeGrid } = await import('/src/volume-grid.js');
  await import('/src/fog-shader.js');
  let size;
  for (const name of gridNames) {
    const grid = decodeVolumeGrid(new Uint8Array(await (await fetch(`${baseUrl}/${name}`)).arrayBuffer()));
    registerVolumeGrid(name, grid);
    size = grid.size.map(extent => extent * voxelMetres);
  }
  const placed = (translation, scale, color, roughness = 0.9) => ({
    geometry: cylinder(128, 0.01, 4),
    matrix: new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]),
    material: { tag: 'surface', color, metallic: 0, roughness, emission: 0 },
  });
  const parts = [placed([0, -0.1, 0], [8, 0.2, 8], [0.62, 0.5, 0.33]), placed([0, -1.3, 0], [8.45, 2.2, 8.45], [0.2, 0.2, 0.22], 0.5), placed([0, -2.35, 0], [9.5, 0.35, 9.5], [0.12, 0.12, 0.13], 0.6)];
  const volume = {
    shape: 'grid', frames: gridNames, fps, loop: false, center: [0, size[1] / 2 - 0.35, 0.4], size, density: 8,
    emission: [1, 0.4, 0.08], emissionStrength: 12, absorption: [0.9, 0.85, 0.8], steps: 96, lightsScene: true,
  };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const renderer = new CrucibleRenderer(canvas, parts, { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false, background: [0.012, 0.014, 0.018] });
  // The camera of the Cycles piece this shot follows: 50 mm lens on a 36 mm sensor, 31 degrees up, 40 m away, drifting round the blast.
  const frameAt = clipFrame => {
    const progress = (75 + clipFrame - 1) / 242;
    const azimuth = (-58 + 14 * progress) * Math.PI / 180;
    const elevation = 31 * Math.PI / 180;
    const reach = 40 - 3 * progress;
    const target = [0, 3, 0];
    // Blender is z up with y toward the back: (x, y, z) becomes (x, z, -y).
    const eye = [target[0] + Math.cos(azimuth) * Math.cos(elevation) * reach, target[1] + Math.sin(elevation) * reach, target[2] - Math.sin(azimuth) * Math.cos(elevation) * reach];
    return { eye, target, focalLength: 50, far: 200, time: clipFrame / fps + 0.0001, environment: { keyIntensity: 0.45, fillIntensity: 0.04, ambientIntensity: 0.1, lightDirection: [-9, 22, -6], localVolumes: [volume] } };
  };
  const pixel = new Uint8Array(4);
  const draw = clipFrame => {
    renderer.render(frameAt(clipFrame));
    renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
  };
  const frameCount = gridNames.length;
  for (let index = 0; index < 8; index++) draw(index);
  const summarize = list => {
    const sorted = [...list].sort((first, second) => first - second);
    return { median: sorted[sorted.length >> 1], p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted[sorted.length - 1] };
  };
  const passes = { changingFrame: [], heldFrame: [] };
  for (let repeat = 0; repeat < repeats; repeat++) {
    const changing = [];
    const held = [];
    for (let index = 0; index < frameCount; index++) {
      const started = performance.now();
      draw(index);
      changing.push(performance.now() - started);
    }
    for (let index = 0; index < frameCount; index++) {
      const started = performance.now();
      draw(frameCount >> 1);
      held.push(performance.now() - started);
    }
    passes.changingFrame.push(summarize(changing));
    passes.heldFrame.push(summarize(held));
  }
  const clipFrames = [];
  if (writeClip) {
    const snapshot = document.createElement('canvas');
    snapshot.width = width;
    snapshot.height = height;
    const snapshotContext = snapshot.getContext('2d');
    for (let index = 0; index < frameCount; index++) {
      draw(index);
      snapshotContext.drawImage(canvas, 0, 0);
      clipFrames.push(snapshot.toDataURL('image/png').split(',')[1]);
    }
  }
  return { passes, clipFrames, glError: renderer.context.getError(), size };
}

const files = createHttpServer((request, response) => {
  const name = decodeURIComponent(request.url.slice(1));
  if (!gridNames.includes(name)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }).end(readFileSync(join(gridFolder, name)));
});
await new Promise(resolve => files.listen(0, '127.0.0.1', resolve));
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: options.width, height: options.height } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const baseUrl = `http://127.0.0.1:${files.address().port}`;
  const result = await page.evaluate(drawSequence, { ...options, baseUrl, gridNames });
  mkdirSync(outputFolder, { recursive: true });
  result.clipFrames.forEach((image, index) => writeFileSync(join(outputFolder, `frame_${String(index).padStart(4, '0')}.png`), Buffer.from(image, 'base64')));
  const round = value => Number(value.toFixed(2));
  const rows = list => list.map(row => ({ median: round(row.median), p95: round(row.p95), worst: round(row.worst) }));
  console.log(JSON.stringify({ grids: gridNames.length, width: options.width, height: options.height, glError: result.glError, sizeMetres: result.size, changingFrameMillisecondsPerFrame: rows(result.passes.changingFrame), heldFrameMillisecondsPerFrame: rows(result.passes.heldFrame) }, null, 2));
  if (result.glError !== 0) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
  files.close();
}
