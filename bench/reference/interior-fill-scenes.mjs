// Prints the interior sky fill (#1334) that each reference scene gets from the default closed-room sky trace, to see which scenes the fill touches.
//   node --import ./bench/reference/register-browser-root.mjs bench/reference/interior-fill-scenes.mjs [scene names...]
import { REFERENCE_SCENES } from './scenes.js';
import { applyDefaultFloorSky } from '../../src/floor-sky-visibility.js';

const requestedNames = process.argv.slice(2);
const names = requestedNames.length > 0 ? requestedNames : Object.keys(REFERENCE_SCENES);
for (const name of names) {
  try {
    const scene = await REFERENCE_SCENES[name]();
    const { report } = applyDefaultFloorSky(scene.parts, scene.environment);
    console.log(`${name}: ${report ? `fill ${(report.interiorFill ?? 0).toFixed(3)} (${report.reason ?? 'traced'})` : 'no sky trace (no sun)'}`);
  } catch (error) {
    console.log(`${name}: could not build in node (${String(error.message).slice(0, 60)})`);
  }
}
