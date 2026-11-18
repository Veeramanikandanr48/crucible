// Tells a flat frame from a picture: the mean luminance step between neighbouring pixels of a small render.
// A scene whose default camera sits behind a wall renders one colour, so every still and frame time from it measures nothing (#2158).
// Steps, not the spread around the mean, because a flat white frame with a vignette still spreads widely (standard deviation 16 of 255)
// while its neighbouring pixels differ by almost nothing.

/** Frames with a mean step below this (of 255) count as flat. Calibrated on Lone Monk behind its wall against the other benchmark scenes (0.32 flat, 2.4 and up for the rest). */
export const MINIMUM_MEAN_LUMINANCE_STEP = 1;

function luminanceAt(pixels, offset) {
  return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
}

/** Mean absolute Rec. 709 luma difference to the right and lower neighbour of 8-bit RGB or RGBA pixels, on a 0 to 255 scale. */
export function meanLuminanceStep(pixels, channels, width) {
  if (channels !== 3 && channels !== 4) throw new Error(`Pass pixels with 3 or 4 channels, got ${channels}.`);
  if (!Number.isInteger(width) || width < 2) throw new Error(`Pass the frame width in pixels (at least 2), got ${width}.`);
  const height = Math.floor(pixels.length / channels / width);
  if (height < 2) throw new Error('Pass at least two rows of pixels to measure.');
  let totalStep = 0;
  let stepCount = 0;
  for (let row = 0; row < height - 1; row++) {
    for (let column = 0; column < width - 1; column++) {
      const offset = (row * width + column) * channels;
      const luma = luminanceAt(pixels, offset);
      totalStep += Math.abs(luma - luminanceAt(pixels, offset + channels));
      totalStep += Math.abs(luma - luminanceAt(pixels, offset + width * channels));
      stepCount += 2;
    }
  }
  return totalStep / stepCount;
}

export function isNearUniformFrame(pixels, channels, width, minimum = MINIMUM_MEAN_LUMINANCE_STEP) {
  return meanLuminanceStep(pixels, channels, width) < minimum;
}
