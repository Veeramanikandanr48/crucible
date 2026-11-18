import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNearUniformFrame, meanLuminanceStep } from '../bench/scene-frames/uniform-frame.mjs';

const WIDTH = 8;
const HEIGHT = 8;

function filled(channels, value) {
  return new Uint8Array(WIDTH * HEIGHT * channels).fill(value);
}

test('a flat white frame has no luminance steps and counts as uniform', () => {
  const white = filled(4, 255);
  assert.ok(meanLuminanceStep(white, 4, WIDTH) < 1e-3);
  assert.equal(isNearUniformFrame(white, 4, WIDTH), true);
});

test('a smooth gradient counts as uniform: its steps are tiny although its values differ across the frame', () => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const column = pixel % WIDTH;
    pixels.fill(255 - Math.abs(column - 3.5) * 2, pixel * 3, pixel * 3 + 3);
  }
  assert.equal(isNearUniformFrame(pixels, 3, WIDTH), true);
});

test('a frame with a dark and a bright half has detail', () => {
  const pixels = filled(3, 30);
  pixels.fill(220, (WIDTH * HEIGHT * 3) / 2);
  assert.ok(meanLuminanceStep(pixels, 3, WIDTH) > 1);
  assert.equal(isNearUniformFrame(pixels, 3, WIDTH), false);
});

test('a checkerboard has detail', () => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    pixels.fill((pixel + Math.floor(pixel / WIDTH)) % 2 === 0 ? 20 : 230, pixel * 3, pixel * 3 + 3);
  }
  assert.equal(isNearUniformFrame(pixels, 3, WIDTH), false);
});

test('bad input says what to pass', () => {
  assert.throws(() => meanLuminanceStep(new Uint8Array(64), 2, WIDTH), /3 or 4 channels/);
  assert.throws(() => meanLuminanceStep(new Uint8Array(64), 4, 1), /frame width/);
  assert.throws(() => meanLuminanceStep(new Uint8Array(8), 4, WIDTH), /two rows/);
});
