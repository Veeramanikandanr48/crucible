// Issue 2000: sky light leaked through the corners of the window room's box walls in the path tracer. The default box
// bevel rounds every edge, and two rounded boxes that touch leave a groove open to the outside at each corner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { createEnvironmentMap } from '../src/environment.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { ROOM_CAMERA, ROOM_GEOMETRIES, ROOM_MATERIALS, roomNodes } from '../bench/reference/interior-room.mjs';

const SKY_RADIANCE = 1;
const SUN_STRENGTH = 3;
const OPTIONS = { width: 160, height: 90, samples: 8, bounces: 3, denoise: false, threads: 1 };

function sealedRoomRecipe(geometries) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries,
    materials: ROOM_MATERIALS,
    nodes: roomNodes({ sealed: true, withoutLawn: true }),
    camera: ROOM_CAMERA,
  };
}

async function brightestSealedPixel(geometries) {
  const { parts } = createAgentScene(sealedRoomRecipe(geometries));
  const environment = {
    keyColor: [SUN_STRENGTH, SUN_STRENGTH, SUN_STRENGTH],
    lightDirection: [0.3, 0.55, -0.8],
    map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(SKY_RADIANCE) }),
  };
  const image = await renderPathTracedImage({ parts, environment, camera: ROOM_CAMERA }, OPTIONS);
  return image.linear.reduce((brightest, value) => Math.max(brightest, value), 0);
}

test('a sealed room built from boxes traces black: no sky light comes in through the wall corners', async () => {
  assert.equal(ROOM_GEOMETRIES[0].bevel, 0, 'the room boxes must have sharp edges');
  assert.equal(await brightestSealedPixel(ROOM_GEOMETRIES), 0);
});

test('the same room with the default rounded boxes does leak, so the check above can fail', async () => {
  const leaked = await brightestSealedPixel([{ id: 'block', type: 'box' }]);
  assert.ok(leaked > 0.1, `a sealed room of rounded boxes should leak sky light at its corners, brightest pixel ${leaked}`);
});
