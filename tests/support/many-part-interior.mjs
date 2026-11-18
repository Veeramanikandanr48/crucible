import { box } from '../../src/geometry.js';

const cube = box(0, 1);

function placed(name, translation, scale, color) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color, metallic: 0, roughness: 0.8, emission: 0 } };
}

/**
 * A closed 12 by 12 room with `partCount` parts in total: a floor, a ceiling, four walls and a deterministic grid of
 * furniture boxes. The same count always gives the same parts.
 */
export function manyPartInterior(partCount) {
  const white = [0.8, 0.8, 0.8];
  const parts = [
    placed('floor', [0, -0.05, 0], [12, 0.1, 12], [0.8, 0.4, 0.1]),
    placed('ceiling', [0, 3.05, 0], [12, 0.1, 12], white),
    placed('back', [0, 1.5, -6.05], [12.2, 3.2, 0.1], white),
    placed('front', [0, 1.5, 6.05], [12.2, 3.2, 0.1], white),
    placed('left', [-6.05, 1.5, 0], [0.1, 3.2, 12], white),
    placed('right', [6.05, 1.5, 0], [0.1, 3.2, 12], white),
  ];
  const columns = 32;
  for (let index = 0; parts.length < partCount; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns) % columns;
    const level = Math.floor(index / (columns * columns));
    const color = [0.3 + 0.5 * ((index * 7) % 5) / 4, 0.4, 0.3 + 0.4 * ((index * 3) % 4) / 3];
    parts.push(placed(`box-${index}`, [-5.5 + column * 0.35, 0.15 + level * 0.4, -5.5 + row * 0.35], [0.25, 0.3, 0.25], color));
  }
  return parts;
}
