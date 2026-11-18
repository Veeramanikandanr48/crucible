// Compositing of render pass pixels on plain buffers: Z combine by depth, alpha-over, and Cryptomatte-style ID mattes.
// Everything works on whole bytes with integer math, so one input gives the same output bytes on every machine.
// Colour and mask buffers are RGBA8, top row first. A render job reads its passes back bottom row first as floats;
// `floatPassToBytes` turns that readback into the same RGBA8 layout.

/** Largest frame a compositing call accepts, the largest frame a render job writes. */
export const MAXIMUM_COMPOSITE_PIXELS = 3840 * 2160;
/** Furthest value of a depth pass step: the background reads this step and never wins a Z combine. */
export const DEPTH_BACKGROUND_STEP = 65535;

function requireFrameSize(width, height) {
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number of pixels, 1 or more. Pass the frame size the buffers were rendered at.`);
  }
  if (width * height > MAXIMUM_COMPOSITE_PIXELS) throw new RangeError(`A frame holds at most ${MAXIMUM_COMPOSITE_PIXELS} pixels (3840x2160). Composite a smaller region.`);
}

function requireBytes(name, buffer, expectedLength) {
  if (!(buffer instanceof Uint8Array || buffer instanceof Uint8ClampedArray)) throw new TypeError(`${name} must be a Uint8Array of RGBA bytes (4 per pixel).`);
  if (buffer.length !== expectedLength) throw new RangeError(`${name} holds ${buffer.length} bytes but the frame needs ${expectedLength} (width x height x 4). Pass a buffer rendered at the same size.`);
}

function requireDepths(name, depths, pixelCount) {
  if (!(depths instanceof Float32Array || depths instanceof Float64Array)) throw new TypeError(`${name} must be a Float32Array of metres, one per pixel. Use depthMetresFromPass to read a depth pass.`);
  if (depths.length !== pixelCount) throw new RangeError(`${name} holds ${depths.length} values but the frame has ${pixelCount} pixels. Pass a depth buffer rendered at the same size.`);
  for (let index = 0; index < depths.length; index++) {
    if (Number.isNaN(depths[index])) throw new RangeError(`${name} has NaN at pixel ${index}. Use Infinity for a pixel with no surface.`);
  }
}

/**
 * Metres per pixel from an RGBA8 depth pass (high byte in red, low byte in green, as the depth pass is written).
 * A background pixel (the far step) reads Infinity, so it loses every Z combine.
 */
export function depthMetresFromPass({ pixels, width, height, depthRange = 100 }) {
  requireFrameSize(width, height);
  requireBytes('pixels', pixels, width * height * 4);
  if (!(depthRange > 0) || !Number.isFinite(depthRange)) throw new RangeError('depthRange must be a positive number of metres. The depth pass spans 100 m by default.');
  const metres = new Float32Array(width * height);
  for (let index = 0; index < metres.length; index++) {
    const step = pixels[index * 4] * 256 + pixels[index * 4 + 1];
    metres[index] = step >= DEPTH_BACKGROUND_STEP ? Infinity : Math.fround(step / DEPTH_BACKGROUND_STEP * depthRange);
  }
  return metres;
}

/**
 * Z combine: for each pixel the colour and depth of the nearer input win. A tie keeps input A.
 * Returns `{ color, depth, nearest }` where `nearest` is 0 where A won and 1 where B won.
 */
export function zCombine({ width, height, colorA, depthA, colorB, depthB }) {
  requireFrameSize(width, height);
  const pixelCount = width * height;
  requireBytes('colorA', colorA, pixelCount * 4);
  requireBytes('colorB', colorB, pixelCount * 4);
  requireDepths('depthA', depthA, pixelCount);
  requireDepths('depthB', depthB, pixelCount);
  const color = new Uint8Array(pixelCount * 4);
  const depth = new Float32Array(pixelCount);
  const nearest = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index++) {
    const useB = depthB[index] < depthA[index];
    const source = useB ? colorB : colorA;
    color.set(source.subarray(index * 4, index * 4 + 4), index * 4);
    depth[index] = useB ? depthB[index] : depthA[index];
    nearest[index] = useB ? 1 : 0;
  }
  return { color, depth, nearest };
}

function roundedDivide(numerator, denominator) {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/**
 * Alpha-over of `foreground` onto `background`, both RGBA8 with straight (not premultiplied) alpha, result straight alpha:
 * out alpha = fa + ba (1 - fa), out colour = (fc fa + bc ba (1 - fa)) / out alpha. Rounded to the nearest byte.
 */
export function alphaOver({ width, height, foreground, background }) {
  requireFrameSize(width, height);
  const pixelCount = width * height;
  requireBytes('foreground', foreground, pixelCount * 4);
  requireBytes('background', background, pixelCount * 4);
  const result = new Uint8Array(pixelCount * 4);
  for (let index = 0; index < pixelCount; index++) {
    const offset = index * 4;
    const foregroundAlpha = foreground[offset + 3];
    const backgroundAlpha = background[offset + 3];
    const backgroundWeight = backgroundAlpha * (255 - foregroundAlpha);
    const foregroundWeight = foregroundAlpha * 255;
    const alphaScaled = foregroundWeight + backgroundWeight;
    if (alphaScaled === 0) continue;
    for (let channel = 0; channel < 3; channel++) {
      const numerator = foreground[offset + channel] * foregroundWeight + background[offset + channel] * backgroundWeight;
      result[offset + channel] = roundedDivide(numerator, alphaScaled);
    }
    result[offset + 3] = roundedDivide(alphaScaled, 255);
  }
  return result;
}

/** The RGBA8 pixels (top row first) of a float pass readback (RGBA, bottom row first, 0..1 per channel). */
export function floatPassToBytes({ pixels, width, height }) {
  requireFrameSize(width, height);
  if (!(pixels instanceof Float32Array) || pixels.length !== width * height * 4) throw new RangeError('pixels must be the Float32Array readback of a pass, width x height x 4 values.');
  const bytes = new Uint8Array(pixels.length);
  const rowValues = width * 4;
  for (let row = 0; row < height; row++) {
    const sourceStart = (height - 1 - row) * rowValues;
    for (let index = 0; index < rowValues; index++) {
      bytes[row * rowValues + index] = Math.round(Math.min(1, Math.max(0, pixels[sourceStart + index])) * 255);
    }
  }
  return bytes;
}

/** The byte a Cryptomatte value (0..1) is stored as in an 8-bit pass. */
export function cryptomatteByte(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/** A 0 or 255 mask of the pixels of an RGBA8 object ID pass (24-bit ID in red, green, blue) whose ID is in `ids`. */
export function objectIdMatte({ pixels, width, height, ids }) {
  requireFrameSize(width, height);
  requireBytes('pixels', pixels, width * height * 4);
  const wanted = new Set(ids ?? []);
  if (wanted.size < 1 || [...wanted].some(id => !Number.isInteger(id) || id < 1 || id > 0xffffff)) {
    throw new RangeError('ids must list one or more object IDs from 1 to 16777215. Read them from metrics.objectNames (ID 1 is the first name).');
  }
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) {
    const id = pixels[index * 4] + pixels[index * 4 + 1] * 256 + pixels[index * 4 + 2] * 65536;
    if (wanted.has(id)) mask[index] = 255;
  }
  return mask;
}

/**
 * A 0 or 255 mask of the surface pixels of an RGBA8 Cryptomatte pass whose object (`channel: 'object'`, red) or
 * material (`channel: 'material'`, green) byte equals the byte of `value`. Coverage in blue must be set, so the background never matches.
 * Hashes are 8-bit, so two names can share a byte: `sharedWith` in the job metrics lists them.
 */
export function cryptomatteMatte({ pixels, width, height, channel, value }) {
  requireFrameSize(width, height);
  requireBytes('pixels', pixels, width * height * 4);
  if (channel !== 'object' && channel !== 'material') throw new TypeError("channel must be 'object' or 'material'. Pass 'object' for the red hash and 'material' for the green hash.");
  if (!(value >= 0 && value <= 1)) throw new RangeError('value must be the Cryptomatte value of the name, 0 to 1. Read it from metrics.cryptomatte.');
  const wantedByte = cryptomatteByte(value);
  const channelOffset = channel === 'object' ? 0 : 1;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) {
    if (pixels[index * 4 + 2] > 0 && pixels[index * 4 + channelOffset] === wantedByte) mask[index] = 255;
  }
  return mask;
}

/** A 0/255 mask as gray RGBA8 with full alpha, ready for the PNG encoder. */
export function matteToGrayRgba(mask) {
  const rgba = new Uint8Array(mask.length * 4);
  for (let index = 0; index < mask.length; index++) {
    rgba.fill(mask[index], index * 4, index * 4 + 3);
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}

/** The same colour buffer with a mask as its alpha channel: the cut-out of the masked part, ready for alphaOver. */
export function applyMatteAsAlpha({ width, height, color, mask }) {
  requireFrameSize(width, height);
  requireBytes('color', color, width * height * 4);
  if (!(mask instanceof Uint8Array) || mask.length !== width * height) throw new RangeError('mask must be a Uint8Array with one byte per pixel at the same size as color.');
  const result = new Uint8Array(color);
  for (let index = 0; index < mask.length; index++) result[index * 4 + 3] = Math.floor(color[index * 4 + 3] * mask[index] / 255);
  return result;
}
