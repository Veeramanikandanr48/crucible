// Renders one frame of an add-explosion grid volume in Blender Cycles, as the reference for the same scene drawn by Glaze (#1736). It writes the grid
// frame as a .67vg file, converts it with scripts/grid-to-vdb.py, and renders it with scripts/cycles-volume-reference.py using the volume's own fields and the
// scene's camera and floor, so the two pictures share scene, camera and gas. Cycles starts below normal priority; the caller runs it through gpu-lock as a heavy job.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setPriority, constants } from 'node:os';
import { join, resolve } from 'node:path';
import { explosionGridBytes } from '../src/explosion-grids.js';
import { decodeVolumeGrid, encodeVolumeGrid, floatToHalf, gridTemperature } from '../src/volume-grid.js';

const DEFAULT_BLENDER = 'C:/Program Files/Blender Foundation/Blender 5.3/blender.exe';
const GRID_FIELDS = ['center', 'size', 'density', 'absorption', 'emission', 'emissionStrength', 'temperatureScale', 'blackbodyIntensity'];

function runBlender(blender, script, scriptArguments) {
  return new Promise((done, fail) => {
    const child = spawn(blender, ['-b', '--factory-startup', '--python', script, '--', ...scriptArguments], { stdio: ['ignore', 'pipe', 'pipe'] });
    try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* the process may already be gone */ }
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    child.on('error', fail);
    child.on('close', code => (code === 0 ? done(log) : fail(new Error(`Blender exited with ${code}: ${log.slice(-600)}`))));
  });
}

// With a flame remap (#1735) Cycles gets Blender's own temperature grid: the temperature channel replaced by the remapped flame, which its Principled Volume
// then reads with Temperature = temperatureScale.
function gridBytesForCycles(bytes, flameTemperature) {
  if (!flameTemperature) return bytes;
  const grid = decodeVolumeGrid(bytes);
  const remapped = gridTemperature(grid, flameTemperature);
  return encodeVolumeGrid({ resolution: grid.resolution, size: grid.size, channels: { ...grid.channels, temperature: Uint16Array.from(remapped, floatToHalf) } });
}

/** Renders `frameIndex` of the grid volume with Cycles and returns the path of the PNG. `floor` null draws the gas on the flat background alone. */
export async function renderCyclesReference({ volume, frameIndex, camera, floor, floorColor, folder, width, height, samples, blender = DEFAULT_BLENDER }) {
  await mkdir(folder, { recursive: true });
  const name = volume.frames[frameIndex];
  const gridPath = join(folder, name);
  await writeFile(gridPath, gridBytesForCycles(explosionGridBytes(name), volume.flameTemperature));
  await runBlender(blender, resolve('scripts/grid-to-vdb.py'), [gridPath, folder]);
  const volumeFields = Object.fromEntries(GRID_FIELDS.map(field => [field, volume[field]]));
  const spec = {
    vdb: [`${name.replace(/\.67vg$/, '')}.vdb`], frame: 0, volume: volumeFields,
    camera: { eye: camera.eye, target: camera.target, up: [0, 1, 0], fov: camera.fov },
    ...(floor === null ? {} : { floor: { y: floor, color: floorColor } }), background: [0.2, 0.22, 0.25],
    image: { width, height, samples, device: 'GPU' },
  };
  await writeFile(join(folder, 'spec.json'), JSON.stringify(spec, null, 2));
  await runBlender(blender, resolve('scripts/cycles-volume-reference.py'), [join(folder, 'spec.json'), join(folder, 'cycles')]);
  return join(folder, 'cycles.png');
}
