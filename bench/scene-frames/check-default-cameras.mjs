// Renders each scene file's own camera small and fails when a frame is nearly one colour:
//   node bench/scene-frames/check-default-cameras.mjs <scene-directory>[,<scene-directory>...] [--width 320] [--height 180]
// A committed override in camera-overrides.json replaces the eye and target of scenes whose exported camera is flat (#2158).
// A scene directory holds scene.json, scene.glb and sky.hdr (see bench/glaze-passes/run.mjs). Exit code 1 lists the flat scenes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../agent-modeling/png-check.mjs';
import { applyCameraOverrideToDirectory } from './camera-overrides.mjs';
import { MINIMUM_MEAN_LUMINANCE_STEP, meanLuminanceStep } from './uniform-frame.mjs';

const RENDER_MEDIA = fileURLToPath(new URL('../../scripts/render-media.mjs', import.meta.url));

function renderDefaultCamera(directory, width, height) {
  applyCameraOverrideToDirectory(directory);
  const work = mkdtempSync(join(tmpdir(), 'scene-frame-'));
  try {
    const output = join(work, 'frame.png');
    const result = spawnSync(process.execPath, [RENDER_MEDIA, '--kind', 'image', '--scene', 'file', '--config', `${directory}/scene.json`, '--width', String(width), '--height', String(height), '--output', output], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`render-media failed for ${directory}: ${(result.stderr || result.stdout).split('\n').slice(-5).join(' ')}`);
    const png = decodePng(readFileSync(output));
    return meanLuminanceStep(png.pixels, png.channels, png.width);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const positional = [];
  let width = 320;
  let height = 180;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--width') width = Number(argv[++index]);
    else if (argv[index] === '--height') height = Number(argv[++index]);
    else positional.push(argv[index]);
  }
  if (positional.length === 0) throw new Error('Pass a comma separated list of scene directories, each holding scene.json.');
  const flat = [];
  for (const directory of positional.join(',').split(',').filter(Boolean).map(entry => resolve(entry))) {
    const deviation = renderDefaultCamera(directory, width, height);
    const verdict = deviation < MINIMUM_MEAN_LUMINANCE_STEP ? 'FLAT' : 'ok';
    console.log(`${verdict}\t${basename(directory)}\tmean luminance step ${deviation.toFixed(3)} of 255 (minimum ${MINIMUM_MEAN_LUMINANCE_STEP})`);
    if (verdict === 'FLAT') flat.push(basename(directory));
  }
  if (flat.length > 0) {
    console.error(`Default camera renders a near-uniform frame: ${flat.join(', ')}. Move eye and target in scene.json to a view that shows the scene.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
