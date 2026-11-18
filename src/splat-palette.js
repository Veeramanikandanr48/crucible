// Palette snapping for gaussian splat scenes drawn with `alphaCut`: each opaque splat pixel takes the nearest palette colour,
// after an optional ordered (Bayer) dither. The shader text and the CPU reference below read the same matrix and constants,
// so a unit test on the reference pins what the GPU draws.

export const SPLAT_PALETTE_LIMITS = Object.freeze({ minimumColors: 2, maximumColors: 256 });
export const SPLAT_DITHER_MODES = Object.freeze(['none', 'bayer4', 'bayer8']);

// How far a dither threshold (from -0.5 to 0.5) pushes each colour channel before the nearest colour is chosen.
export const SPLAT_DITHER_SPREAD = 0.25;

const DITHER_SIZES = Object.freeze({ none: 0, bayer4: 4, bayer8: 8 });

/** The n x n Bayer index matrix (n a power of two), row by row, holding 0 to n*n - 1. */
export function buildBayerMatrix(size) {
  let matrix = [0];
  for (let side = 1; side < size; side *= 2) {
    const next = new Array(side * side * 4);
    for (let row = 0; row < side * 2; row++) {
      for (let column = 0; column < side * 2; column++) {
        const base = 4 * matrix[(row % side) * side + (column % side)];
        const quadrantOffset = [[0, 2], [3, 1]][Math.floor(row / side)][Math.floor(column / side)];
        next[row * side * 2 + column] = base + quadrantOffset;
      }
    }
    matrix = next;
  }
  return matrix;
}

function parseHexColor(text, label) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!match) {
    throw new RangeError(`${label} must be a hex colour such as '#a1b2c3' or '#abc', or an [r, g, b] array of numbers from 0 to 1, got ${JSON.stringify(text)}`);
  }
  const digits = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join('') : match[1];
  return [0, 2, 4].map(offset => parseInt(digits.slice(offset, offset + 2), 16) / 255);
}

function parseArrayColor(color, label) {
  const valid = color.length === 3 && color.every(value => typeof value === 'number' && value >= 0 && value <= 1);
  if (!valid) {
    throw new RangeError(`${label} must be a hex colour such as '#a1b2c3' or an [r, g, b] array of three numbers from 0 to 1, got ${JSON.stringify(color)}`);
  }
  return color;
}

/** A colour option as three numbers from 0 to 1: a hex string or an [r, g, b] array. `label` names the field in errors. */
export function parseSplatColor(color, label) {
  if (typeof color === 'string') return parseHexColor(color, label);
  if (Array.isArray(color)) return parseArrayColor(color, label);
  throw new RangeError(`${label} must be a hex colour such as '#a1b2c3' or an [r, g, b] array of numbers from 0 to 1, got ${String(color)}`);
}

/**
 * Checks the `palette` and `dither` options of createGaussianSplats and returns `{ colors, count, dither }` (colors is a
 * Float32Array of r, g, b per colour), or null when no palette is given.
 */
export function resolveSplatPalette(palette, dither, alphaCut, caller) {
  if (palette === undefined || palette === null) {
    if (dither !== undefined && dither !== 'none') {
      throw new TypeError(`${caller} dither needs a palette to snap to: pass palette as an array of 2 to 256 colours, or leave dither out`);
    }
    return null;
  }
  const { minimumColors, maximumColors } = SPLAT_PALETTE_LIMITS;
  if (!Array.isArray(palette) || palette.length < minimumColors || palette.length > maximumColors) {
    throw new RangeError(`${caller} palette must be an array of ${minimumColors} to ${maximumColors} colours (hex strings or [r, g, b] arrays from 0 to 1), got ${Array.isArray(palette) ? `${palette.length} colours` : typeof palette}`);
  }
  const resolvedDither = dither ?? 'none';
  if (!SPLAT_DITHER_MODES.includes(resolvedDither)) {
    throw new RangeError(`${caller} dither must be one of ${SPLAT_DITHER_MODES.map(mode => `'${mode}'`).join(', ')}, got ${JSON.stringify(dither)}`);
  }
  if (alphaCut === null) {
    throw new TypeError(`${caller} palette needs alphaCut (a number from 0 to 1) so the splats draw as opaque discs; blended pixels cannot be snapped to a palette. Pass alphaCut: 0.5, or leave palette out`);
  }
  const colors = new Float32Array(palette.length * 3);
  palette.forEach((color, position) => colors.set(parseSplatColor(color, `palette[${position}]`), position * 3));
  return { colors, count: palette.length, dither: resolvedDither };
}

function ditherOffset(mode, pixelX, pixelY) {
  const size = DITHER_SIZES[mode];
  if (size === 0) return 0;
  const matrix = buildBayerMatrix(size);
  const index = matrix[(pixelY % size) * size + (pixelX % size)];
  return ((index + 0.5) / (size * size) - 0.5) * SPLAT_DITHER_SPREAD;
}

/**
 * The palette colour the shader writes for a splat colour `rgb` (three numbers from 0 to 1) at integer pixel
 * (`pixelX`, `pixelY`) of the canvas. The nearest colour by squared RGB distance wins, the first on a tie.
 */
export function snapToSplatPalette(rgb, pixelX, pixelY, palette) {
  const offset = ditherOffset(palette.dither, pixelX, pixelY);
  const shifted = rgb.map(value => Math.min(Math.max(value + offset, 0), 1));
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.count; index++) {
    const distance = [0, 1, 2].reduce((sum, channel) => sum + (shifted[channel] - palette.colors[index * 3 + channel]) ** 2, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return Array.from(palette.colors.subarray(bestIndex * 3, bestIndex * 3 + 3));
}

function ditherShaderLines(mode) {
  const size = DITHER_SIZES[mode];
  if (size === 0) return '';
  const matrix = buildBayerMatrix(size);
  return `const int BAYER[${size * size}] = int[${size * size}](${matrix.join(', ')});
  ivec2 pixel = ivec2(gl_FragCoord.xy) % ${size};
  float threshold = (float(BAYER[pixel.y * ${size} + pixel.x]) + 0.5) / ${size * size}.0 - 0.5;
  source = clamp(source + threshold * ${SPLAT_DITHER_SPREAD.toFixed(2)}, 0.0, 1.0);`;
}

/** The opaque fragment shader with the palette step: `count` colours in the uniform array `paletteColors`. */
export function buildPaletteFragmentSource(count, mode) {
  return `#version 300 es
precision highp float;
uniform float hdrEnabled;
uniform float exposure;
uniform float alphaCut;
uniform vec3 paletteColors[${count}];
in vec4 vertexColor;
in vec2 vertexOffset;
out vec4 outputColor;
void main() {
  float falloff = -dot(vertexOffset, vertexOffset);
  if (falloff < -4.0) discard;
  float alpha = exp(falloff) * vertexColor.a;
  if (alpha < max(alphaCut, 1.0 / 255.0)) discard;
  vec3 source = vertexColor.rgb;
  ${ditherShaderLines(mode)}
  vec3 snapped = paletteColors[0];
  float bestDistance = dot(source - snapped, source - snapped);
  for (int index = 1; index < ${count}; index++) {
    vec3 difference = source - paletteColors[index];
    float distanceToColor = dot(difference, difference);
    if (distanceToColor < bestDistance) {
      bestDistance = distanceToColor;
      snapped = paletteColors[index];
    }
  }
  vec3 color = hdrEnabled > 0.5 ? pow(snapped, vec3(2.2)) * exposure : snapped;
  outputColor = vec4(color, 1.0);
}`;
}
