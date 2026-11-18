// The sky light that a closed room's surfaces bounce on to each other (#1334): the raster darkened every point the window cannot
// see to the level of a sealed room, while a path tracer lights them with the light that came in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { applyDefaultFloorSky, interiorSkyFill, interiorFillTint, interiorCornerWeight, INTERIOR_FILL_MAXIMUM } from '../src/floor-sky-visibility.js';

const HALF_WIDTH = 4;
const FRONT = -3;
const BACK = 3.5;
const HEIGHT = 3;
const WALL = 0.2;
const SUN = { keyIntensity: 1, lightDirection: [0.3, 0.55, -0.8] };
const PLASTER = [0.75, 0.72, 0.66];
const WOOD = [0.45, 0.32, 0.2];

function slab(name, center, size, color = [0.7, 0.7, 0.7]) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name, geometry: box(0, 1), matrix, material: { color, metallic: 0, roughness: 0.9 } };
}

// The probe room of bench/reference/interior-exposure.mjs: a window in the front wall, or none when sealed.
function room({ window, warm = false }) {
  const depth = BACK - FRONT;
  const middleZ = (FRONT + BACK) / 2;
  const frontZ = FRONT - WALL / 2;
  const parts = [
    slab('floor', [0, -WALL / 2, middleZ], [HALF_WIDTH * 2 + WALL * 2, WALL, depth + WALL * 2], warm ? WOOD : undefined),
    slab('ceiling', [0, HEIGHT + WALL / 2, middleZ], [HALF_WIDTH * 2 + WALL * 2, WALL, depth + WALL * 2], warm ? PLASTER : undefined),
    slab('wall-left', [-HALF_WIDTH - WALL / 2, HEIGHT / 2, middleZ], [WALL, HEIGHT, depth + WALL * 2], warm ? PLASTER : undefined),
    slab('wall-right', [HALF_WIDTH + WALL / 2, HEIGHT / 2, middleZ], [WALL, HEIGHT, depth + WALL * 2], warm ? PLASTER : undefined),
    slab('wall-back', [0, HEIGHT / 2, BACK + WALL / 2], [HALF_WIDTH * 2, HEIGHT, WALL], warm ? PLASTER : undefined),
  ];
  if (!window) {
    parts.push(slab('wall-front', [0, HEIGHT / 2, frontZ], [HALF_WIDTH * 2, HEIGHT, WALL]));
    return parts;
  }
  const opening = { halfWidth: 1.4, bottom: 0.9, top: 2.4 };
  const side = HALF_WIDTH - opening.halfWidth;
  parts.push(
    slab('front-left', [-(opening.halfWidth + side / 2), HEIGHT / 2, frontZ], [side, HEIGHT, WALL]),
    slab('front-right', [opening.halfWidth + side / 2, HEIGHT / 2, frontZ], [side, HEIGHT, WALL]),
    slab('front-sill', [0, opening.bottom / 2, frontZ], [opening.halfWidth * 2, opening.bottom, WALL]),
    slab('front-head', [0, (opening.top + HEIGHT) / 2, frontZ], [opening.halfWidth * 2, HEIGHT - opening.top, WALL]),
  );
  return parts;
}

// The mean sky visibility of the vertices whose normal points along `normalAxis` in the direction `normalSign`.
function faceMean(part, normalAxis, normalSign) {
  const { skyVisibility, normals } = part.geometry;
  let sum = 0;
  let count = 0;
  for (let vertex = 0; vertex < skyVisibility.length; vertex++) {
    if (Math.round(normals[vertex * 3 + normalAxis]) !== normalSign) continue;
    sum += skyVisibility[vertex];
    count += 1;
  }
  return sum / count;
}

test('the fill follows the bounce series: nothing for a sealed room, more for a brighter and more open room', () => {
  assert.equal(interiorSkyFill(0, 0.6), 0);
  assert.equal(interiorSkyFill(0.03, 0), 0);
  // 4 (fitted gain) x 0.6 x 0.03 / (1 - 0.6 x 0.97)
  assert.ok(Math.abs(interiorSkyFill(0.03, 0.6) - 0.1722) < 0.001, `got ${interiorSkyFill(0.03, 0.6)}`);
  assert.ok(interiorSkyFill(0.03, 0.8) > interiorSkyFill(0.03, 0.4));
  assert.ok(interiorSkyFill(0.06, 0.6) > interiorSkyFill(0.03, 0.6));
  assert.equal(interiorSkyFill(0.9, 0.9), INTERIOR_FILL_MAXIMUM);
});

test('a room with a window reports its fill, and a sealed room reports none', () => {
  const windowed = applyDefaultFloorSky(room({ window: true }), SUN, { maximumTexels: 4000 }).report;
  const sealed = applyDefaultFloorSky(room({ window: false }), SUN, { maximumTexels: 4000 }).report;
  assert.ok(windowed.interiorFill > 0.1 && windowed.interiorFill < 0.3, `window room fill ${windowed.interiorFill}`);
  assert.equal(sealed.interiorFill, 0);
});

test('the fill lifts the inside faces of a windowed room and leaves its outside faces and a sealed room alone', () => {
  const windowed = applyDefaultFloorSky(room({ window: true }), SUN, { maximumTexels: 4000 }).parts;
  const sealed = applyDefaultFloorSky(room({ window: false }), SUN, { maximumTexels: 4000 }).parts;
  const insideBackWallWindowed = faceMean(windowed.find(part => part.name === 'wall-back'), 2, -1);
  const insideBackWallSealed = faceMean(sealed.find(part => part.name === 'wall-back'), 2, -1);
  assert.ok(insideBackWallWindowed > insideBackWallSealed + 0.15, `inside back wall ${insideBackWallWindowed.toFixed(3)} against sealed ${insideBackWallSealed.toFixed(3)}`);
  assert.ok(insideBackWallSealed < 0.1, `a sealed room stays dark inside: ${insideBackWallSealed.toFixed(3)}`);
  const outsideRoof = faceMean(windowed.find(part => part.name === 'ceiling'), 1, 1);
  assert.ok(outsideRoof > 0.9, `the roof stays open to the sky: ${outsideRoof.toFixed(3)}`);
});

test('an open scene gets no fill', () => {
  const open = [room({ window: false })[0], room({ window: false })[2]];
  const { report } = applyDefaultFloorSky(open, SUN, { maximumTexels: 4000 });
  assert.equal(report.interiorFill ?? 0, 0);
});

// The vertices of the inside face of the back wall, as `{ visibility, color, height }` (the world height of the vertex).
function backWallInsideVertices(part) {
  const { skyVisibility, normals, colors, positions } = part.geometry;
  const vertices = [];
  for (let vertex = 0; vertex < skyVisibility.length; vertex++) {
    if (Math.round(normals[vertex * 3 + 2]) !== -1) continue;
    const height = part.matrix[5] * positions[vertex * 3 + 1] + part.matrix[13];
    vertices.push({ visibility: skyVisibility[vertex], color: [colors[vertex * 3], colors[vertex * 3 + 1], colors[vertex * 3 + 2]], height });
  }
  return vertices;
}

// The mean red over blue of the colour of the floor's top-face vertices within 0.3 m of the world point (x, z).
function floorColorAround(part, x, z) {
  const { colors, normals, positions } = part.geometry;
  const ratios = [];
  for (let vertex = 0; vertex < normals.length / 3; vertex++) {
    if (Math.round(normals[vertex * 3 + 1]) !== 1) continue;
    const worldX = part.matrix[0] * positions[vertex * 3] + part.matrix[12];
    const worldZ = part.matrix[10] * positions[vertex * 3 + 2] + part.matrix[14];
    if (Math.hypot(worldX - x, worldZ - z) < 0.3) ratios.push(colors[vertex * 3] / colors[vertex * 3 + 2]);
  }
  assert.ok(ratios.length > 0, `no floor vertex near ${x}, ${z}`);
  return mean(ratios);
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

test('the tint turns the shader blue ambient into the colour the room bounces, without changing its level', () => {
  const luminance = tint => 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
  const neutral = interiorFillTint([0.6, 0.6, 0.6]);
  const warm = interiorFillTint([0.66, 0.6, 0.52]);
  assert.ok(neutral[0] > 1 && neutral[2] < 1, `a grey room undoes the blue of the sky term: ${neutral}`);
  assert.ok(warm[0] / warm[2] > neutral[0] / neutral[2] + 0.1, `a warm room tints warmer than a grey one: ${warm} against ${neutral}`);
  assert.ok(Math.abs(luminance(neutral) - 1) < 1e-9 && Math.abs(luminance(warm) - 1) < 1e-9);
});

test('the corner weight is 1 in the open and falls as more rays meet a surface close by', () => {
  assert.equal(interiorCornerWeight(0), 1);
  assert.ok(interiorCornerWeight(0.5) < interiorCornerWeight(0.2));
  assert.ok(interiorCornerWeight(1) > 0.4 && interiorCornerWeight(1) < 0.8, `the most a corner loses is ${1 - interiorCornerWeight(1)}`);
});

test('the fill is warm on the walls of a warm room, and the sealed room and the sunlit floor keep their colour', () => {
  const windowed = applyDefaultFloorSky(room({ window: true, warm: true }), SUN, { maximumTexels: 4000 }).parts;
  const sealed = applyDefaultFloorSky(room({ window: false, warm: true }), SUN, { maximumTexels: 4000 }).parts;
  const wallColors = backWallInsideVertices(windowed.find(part => part.name === 'wall-back')).map(vertex => vertex.color);
  const redOverBlue = mean(wallColors.map(color => color[0] / color[2]));
  assert.ok(redOverBlue > 1.2, `the back wall's fill is warm: red over blue ${redOverBlue.toFixed(2)}`);
  for (const part of sealed) {
    assert.ok(part.geometry.colors.every(channel => channel === 1), `a sealed room keeps white vertex colours (${part.name})`);
  }
  const floor = windowed.find(part => part.name === 'floor');
  // Sun toward [0.3, 0.55, -0.8] through the window lands on the floor around x -1.4, z -0.6 (the patch's middle); the far corner stays in shade.
  const sunlitRedOverBlue = floorColorAround(floor, -1.4, -0.6);
  const shadedRedOverBlue = floorColorAround(floor, 2.5, 2.5);
  assert.ok(Math.abs(sunlitRedOverBlue - 1) < 1e-6, `the floor where the sun lands keeps its colour: red over blue ${sunlitRedOverBlue}`);
  assert.ok(shadedRedOverBlue > 1.1, `the shaded floor takes the tint: red over blue ${shadedRedOverBlue}`);
});

test('the fill fades toward the wall/floor junction instead of staying flat', () => {
  const windowed = applyDefaultFloorSky(room({ window: true }), SUN, { maximumTexels: 4000 }).parts;
  const vertices = backWallInsideVertices(windowed.find(part => part.name === 'wall-back'));
  const nearFloor = mean(vertices.filter(vertex => vertex.height < 0.2).map(vertex => vertex.visibility));
  const middle = mean(vertices.filter(vertex => vertex.height > 1.2 && vertex.height < 1.8).map(vertex => vertex.visibility));
  assert.ok(nearFloor < middle - 0.03, `the junction is darker: ${nearFloor.toFixed(3)} against the wall's middle ${middle.toFixed(3)}`);
});
