// A pixel outline round the silhouette of a gaussian splat scene drawn with `alphaCut`. The outline is drawn before the fills,
// without writing depth, from the same splats grown by the outline width: a pixel takes the outline colour when its distance to
// the edge of the cut disc is within the width. Any fill then covers the outline, so only the outer silhouette keeps it.
// `dilateSplatMask` below is the discrete reference of that rule, so a unit test on it pins what the shader should draw.

import { parseSplatColor } from './splat-palette.js';

export const SPLAT_OUTLINE_LIMITS = Object.freeze({ minimumWidth: 1, maximumWidth: 4 });
export const SPLAT_OUTLINE_DEFAULT_COLOR = Object.freeze([0.04, 0.04, 0.06]);

function describe(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
}

/**
 * Checks the `outline` option of createGaussianSplats and returns `{ color, width }` (color is three numbers from 0 to 1),
 * or null when no outline is asked for.
 */
export function resolveSplatOutline(outline, alphaCut, caller) {
  if (outline === undefined || outline === null) return null;
  if (typeof outline !== 'object' || Array.isArray(outline)) {
    throw new TypeError(`${caller} outline must be an object such as { color: '#101018', width: 1 }, got ${describe(outline)}`);
  }
  const { minimumWidth, maximumWidth } = SPLAT_OUTLINE_LIMITS;
  const { color, width = minimumWidth } = outline;
  if (!Number.isInteger(width) || width < minimumWidth || width > maximumWidth) {
    throw new RangeError(`${caller} outline.width must be a whole number of pixels from ${minimumWidth} to ${maximumWidth}, got ${JSON.stringify(width)}`);
  }
  const resolvedColor = color === undefined ? [...SPLAT_OUTLINE_DEFAULT_COLOR] : parseSplatColor(color, 'outline.color');
  if (alphaCut === null) {
    throw new TypeError(`${caller} outline needs alphaCut (a number from 0 to 1): a soft blended edge has no silhouette to outline. Pass alphaCut: 0.5, or leave outline out`);
  }
  return { color: resolvedColor, width };
}

/**
 * The outline pixels of a silhouette. `rows` is an array of equal-length strings where '#' is inside the silhouette; the
 * result has 'o' on every outside pixel whose centre is within `width` pixels (straight-line distance) of an inside pixel
 * centre, '#' unchanged and '.' elsewhere.
 */
export function dilateSplatMask(rows, width) {
  return rows.map((row, y) => [...row].map((cell, x) => {
    if (cell === '#') return '#';
    for (let offsetY = -width; offsetY <= width; offsetY++) {
      for (let offsetX = -width; offsetX <= width; offsetX++) {
        const inside = rows[y + offsetY]?.[x + offsetX] === '#';
        if (inside && offsetX * offsetX + offsetY * offsetY <= width * width) return 'o';
      }
    }
    return '.';
  }).join(''));
}

const VIEWPORT_LINE = 'uniform vec2 viewport;';
const CORNER_LINE = 'vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 4.0 - 2.0;';

function replaceOnce(source, line, replacement) {
  if (!source.includes(line)) throw new Error(`The splat vertex shader no longer contains "${line}"; update buildOutlineVertexSource`);
  return source.replace(line, replacement);
}

/** The splat vertex shader with each quad grown by the outline width plus one pixel, so the outline has room to draw. */
export function buildOutlineVertexSource(vertexSource) {
  const withUniform = replaceOnce(vertexSource, VIEWPORT_LINE, `${VIEWPORT_LINE}\nuniform float outlineWidth;`);
  return replaceOnce(withUniform, CORNER_LINE, `${CORNER_LINE}
  corner *= 1.0 + (outlineWidth + 1.0) / (2.0 * vec2(length(majorAxis), length(minorAxis)));`);
}

// The edge of the cut disc is where `edgeSquared - dot(offset, offset)` is zero; dividing that by its screen-space gradient
// gives the distance to the edge in pixels, exact for a straight edge and close for a curved one.
export const OUTLINE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform float hdrEnabled;
uniform float exposure;
uniform float alphaCut;
uniform float outlineWidth;
uniform vec3 outlineColor;
in vec4 vertexColor;
in vec2 vertexOffset;
out vec4 outputColor;
void main() {
  float cut = max(alphaCut, 1.0 / 255.0);
  if (vertexColor.a < cut) discard;
  float edgeSquared = min(4.0, log(vertexColor.a / cut));
  float inside = edgeSquared - dot(vertexOffset, vertexOffset);
  float gradient = max(length(vec2(dFdx(inside), dFdy(inside))), 1e-6);
  if (-inside / gradient > outlineWidth) discard;
  vec3 color = hdrEnabled > 0.5 ? pow(outlineColor, vec3(2.2)) * exposure : outlineColor;
  outputColor = vec4(color, 1.0);
}`;
