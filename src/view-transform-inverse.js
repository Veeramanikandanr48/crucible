import { applyViewTransform } from './view-transform.js';

// The inverse of the display path for a picked colour: radiance that the view transform and the 1 / 2.2 display power
// return as the colour asked for. aces is inverted in closed form per channel; agx and neutral mix the channels, so they
// are solved with a few Newton steps. A display value that no radiance reaches (a channel the transform never produces,
// such as pure white under agx) lands on the nearest value the solver found, and `error` says how far off it is.

const DISPLAY_POWER = 2.2;
const NEWTON_STEPS = 24;
const DIFFERENCE_STEP = 1e-4;
const ACCEPTED_ERROR = 1e-4;
const LARGEST_RADIANCE = 1e4;

/** Radiance for one ACES channel (the rasterizer's Narkowicz fit) that maps to `target` in 0 to 1. */
export function inverseAcesChannel(target) {
  const level = Math.min(1, Math.max(0, target));
  const quadratic = 2.51 - 2.43 * level;
  const linear = 0.03 - 0.59 * level;
  const constant = -0.14 * level;
  return (-linear + Math.sqrt(linear * linear - 4 * quadratic * constant)) / (2 * quadratic);
}

function solveThreeByThree(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < 3; pivot++) {
    let best = pivot;
    for (let row = pivot + 1; row < 3; row++) {
      if (Math.abs(rows[row][pivot]) > Math.abs(rows[best][pivot])) best = row;
    }
    if (Math.abs(rows[best][pivot]) < 1e-12) return null;
    [rows[pivot], rows[best]] = [rows[best], rows[pivot]];
    for (let row = 0; row < 3; row++) {
      if (row === pivot) continue;
      const factor = rows[row][pivot] / rows[pivot][pivot];
      for (let column = pivot; column < 4; column++) rows[row][column] -= factor * rows[pivot][column];
    }
  }
  return rows.map((row, index) => row[3] / row[index]);
}

function largestDifference(first, second) {
  return Math.max(...first.map((value, channel) => Math.abs(value - second[channel])));
}

function solveMixedChannels(name, target) {
  const forward = radiance => applyViewTransform(name, radiance);
  let radiance = target.map(channel => Math.max(channel, 1e-4));
  let best = { radiance, error: largestDifference(forward(radiance), target) };
  for (let step = 0; step < NEWTON_STEPS && best.error > ACCEPTED_ERROR; step++) {
    const current = forward(radiance);
    const columns = radiance.map((value, channel) => {
      const nudged = [...radiance];
      nudged[channel] = value + DIFFERENCE_STEP;
      return forward(nudged).map((result, row) => (result - current[row]) / DIFFERENCE_STEP);
    });
    const jacobian = [0, 1, 2].map(row => columns.map(column => column[row]));
    const move = solveThreeByThree(jacobian, current.map((value, channel) => value - target[channel]));
    if (move === null) break;
    radiance = radiance.map((value, channel) => Math.min(LARGEST_RADIANCE, Math.max(0, value - move[channel])));
    const error = largestDifference(forward(radiance), target);
    if (error < best.error) best = { radiance, error };
  }
  return best;
}

/**
 * Radiance that displays as `displayEncoded` (RGB in 0 to 1, the pixel as shown) under `viewTransform`.
 * Returns { radiance, error }: error is the largest channel gap, in display-linear units, between the round trip and the
 * request; it is 0 for aces and below 1e-4 where agx and neutral can reach the colour.
 */
export function radianceForDisplayColor(displayEncoded, viewTransform = 'aces') {
  const target = displayEncoded.map(channel => Math.min(1, Math.max(0, channel)) ** DISPLAY_POWER);
  if (viewTransform === 'aces') {
    return { radiance: target.map(inverseAcesChannel), error: 0 };
  }
  return solveMixedChannels(viewTransform, target);
}
