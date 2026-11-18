import test from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere } from '../src/geometry.js';
import { bakeLightmaps } from '../src/light-bake.js';

function placed(name, geometry, translation, scale) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry, matrix, material: { tag: 'surface', color: [0.8, 0.78, 0.72], metallic: 0, roughness: 1, emission: 0 } };
}

function srgbByteToLinear(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// The bilinear read of the green channel of a lightmap, as linear light, at a texture coordinate.
function lightmapReader({ data, width, height }) {
  const texel = (column, row) => {
    const clampedColumn = Math.min(Math.max(column, 0), width - 1);
    const clampedRow = Math.min(Math.max(row, 0), height - 1);
    return srgbByteToLinear(data[(clampedRow * width + clampedColumn) * 4 + 1]);
  };
  return (u, v) => {
    const x = u * width - 0.5;
    const y = v * height - 0.5;
    const column = Math.floor(x);
    const row = Math.floor(y);
    const across = x - column;
    const down = y - row;
    const upper = texel(column, row) * (1 - across) + texel(column + 1, row) * across;
    const lower = texel(column, row + 1) * (1 - across) + texel(column + 1, row + 1) * across;
    return upper * (1 - down) + lower * down;
  };
}

function positionKey(positions, vertex) {
  return [0, 1, 2].map(axis => positions[vertex * 3 + axis].toFixed(5)).join(',');
}

/**
 * Where a smooth mesh is cut into charts, one surface point has two lightmap coordinates. Reads the light at both, at five points
 * along every edge shared by two triangles that sit in different places of the lightmap, and returns the largest and the mean
 * difference as a share of the brightest texel. Edges that bend sharply are real corners and are left out.
 */
function seamJump(part) {
  const { positions, normals, indices, uvs } = part.geometry;
  const { image } = part.material.emissiveMap;
  const readLight = lightmapReader(image);
  let peak = 1e-6;
  for (let channel = 1; channel < image.data.length; channel += 4) peak = Math.max(peak, srgbByteToLinear(image.data[channel]));
  const sides = new Map();
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const from = indices[triangle * 3 + corner];
      const to = indices[triangle * 3 + (corner + 1) % 3];
      const fromKey = positionKey(positions, from);
      const toKey = positionKey(positions, to);
      const edgeKey = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
      if (!sides.has(edgeKey)) sides.set(edgeKey, []);
      sides.get(edgeKey).push({ from, to, fromKey });
    }
  }
  let largest = 0;
  let total = 0;
  let count = 0;
  for (const [first, second, ...others] of sides.values()) {
    if (!second || others.length > 0) continue;
    const bend = [0, 1, 2].reduce((sum, axis) => sum + normals[first.from * 3 + axis] * normals[second.from * 3 + axis], 0);
    if (bend < 0.9) continue;
    for (const along of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const coordinate = (side) => {
        const fraction = side.fromKey === first.fromKey ? along : 1 - along;
        return [0, 1].map(axis => uvs[side.from * 2 + axis] * (1 - fraction) + uvs[side.to * 2 + axis] * fraction);
      };
      const [firstU, firstV] = coordinate(first);
      const [secondU, secondV] = coordinate(second);
      if (Math.hypot(firstU - secondU, firstV - secondV) < 1e-6) continue;
      const jump = Math.abs(readLight(firstU, firstV) - readLight(secondU, secondV)) / peak;
      largest = Math.max(largest, jump);
      total += jump;
      count++;
    }
  }
  return { largest, mean: count > 0 ? total / count : 0, count };
}

function bakedBall() {
  const parts = [placed('floor', box(0, 1), [0, -0.1, 0], [6, 0.2, 6]), placed('ball', sphere(), [1.2, 0.5, 0.4], [1, 1, 1])];
  const lighting = { pointLights: [{ position: [0, 2.8, 0], color: [1, 0.85, 0.65], intensity: 18, radius: 0.1, range: 9 }], keyColor: [0, 0, 0] };
  return bakeLightmaps(parts, lighting, { samples: 128, bounces: 3, texelsPerUnit: 6 }).parts[1];
}

test('the light of a baked sphere does not step where its charts meet', () => {
  // The unwrap cut the sphere into six charts packed with less than a texel between them, and the smoothing averaged each chart
  // edge from its own side only. Bilinear reads at a chart edge then took the neighbouring chart's texels and a biased average,
  // so the same surface point read up to 70 percent of the brightest texel apart on its two sides.
  const { largest, mean, count } = seamJump(bakedBall());
  assert.ok(count > 500, `the sphere has ${count} seam samples`);
  assert.ok(largest < 0.12, `largest seam jump is ${(largest * 100).toFixed(1)} percent of the peak`);
  assert.ok(mean < 0.03, `mean seam jump is ${(mean * 100).toFixed(1)} percent of the peak`);
});

test('baking the same sphere twice gives the same lightmap bytes', () => {
  const first = bakedBall().material.emissiveMap.image.data;
  const second = bakedBall().material.emissiveMap.image.data;
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});
