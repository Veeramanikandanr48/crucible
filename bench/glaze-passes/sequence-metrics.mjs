// Between-frame shimmer and level popping of camera moves written by run.mjs with '"sequence":{"directory":...}':
// node bench/glaze-passes/sequence-metrics.mjs <reference-directory> <directory>[,<directory>...] [width] [height]
// The reference is the same move drawn without levels. For each directory it prints:
//   shimmer: mean absolute high-pass (value minus its 5 x 5 box blur) of the frame-to-frame luma difference, over the
//            detailed pixels (the top tenth by spatial high-pass energy in the reference), on the 0 to 255 scale;
//            the reference's own value is the floor of what the move itself causes.
//   addedShimmer: the same measure on the error against the reference (the frame minus the reference frame), so
//            the motion's own edges cancel and only what the levels add is left.
//   pop:     RMSE over the frame of the change, from one frame to the next, of the error against the reference
//            (popMedian is the steady drift of the error); popSpike is the largest amount by which one frame's
//            change exceeds the median change of the six frames around it, which is a level switch.
import { readdir, readFile } from 'node:fs/promises';

const [referenceDirectory, directoryList, widthText = '1280', heightText = '720'] = process.argv.slice(2);
if (!referenceDirectory || !directoryList) throw new Error('Pass the reference frame directory and a comma separated list of frame directories.');
const width = Number(widthText);
const height = Number(heightText);
const HIGH_PASS_RADIUS = 2;
const DETAIL_FRACTION = 0.1;

async function readLumaFrames(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.rgba')).sort();
  const frames = [];
  for (const name of names) {
    const rgba = await readFile(`${directory}/${name}`);
    if (rgba.length !== width * height * 4) throw new Error(`${directory}/${name} must be ${width} x ${height} RGBA.`);
    const luma = new Float32Array(width * height);
    for (let pixel = 0; pixel < luma.length; pixel++) luma[pixel] = 0.2126 * rgba[pixel * 4] + 0.7152 * rgba[pixel * 4 + 1] + 0.0722 * rgba[pixel * 4 + 2];
    frames.push(luma);
  }
  return frames;
}

function boxBlur(image) {
  const horizontal = new Float32Array(image.length);
  const size = HIGH_PASS_RADIUS * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let offset = -HIGH_PASS_RADIUS; offset <= HIGH_PASS_RADIUS; offset++) sum += image[y * width + Math.min(width - 1, Math.max(0, x + offset))];
      horizontal[y * width + x] = sum / size;
    }
  }
  const blurred = new Float32Array(image.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let offset = -HIGH_PASS_RADIUS; offset <= HIGH_PASS_RADIUS; offset++) sum += horizontal[Math.min(height - 1, Math.max(0, y + offset)) * width + x];
      blurred[y * width + x] = sum / size;
    }
  }
  return blurred;
}

function highPass(image) {
  const blurred = boxBlur(image);
  return image.map((value, index) => value - blurred[index]);
}

function difference(later, earlier) {
  return later.map((value, index) => value - earlier[index]);
}

function detailMask(referenceFrames) {
  const energy = new Float32Array(width * height);
  for (const frame of referenceFrames) highPass(frame).forEach((value, index) => { energy[index] += Math.abs(value) / referenceFrames.length; });
  const threshold = [...energy].sort((first, second) => first - second)[Math.floor(energy.length * (1 - DETAIL_FRACTION))];
  return energy.map(value => (value >= threshold ? 1 : 0));
}

function shimmer(frames, mask) {
  let total = 0;
  const maskedPixels = mask.reduce((sum, value) => sum + value, 0);
  for (let index = 1; index < frames.length; index++) {
    const filtered = highPass(difference(frames[index], frames[index - 1]));
    let sum = 0;
    for (let pixel = 0; pixel < filtered.length; pixel++) if (mask[pixel]) sum += Math.abs(filtered[pixel]);
    total += sum / maskedPixels;
  }
  return total / (frames.length - 1);
}

function errorFrames(frames, referenceFrames) {
  return frames.map((frame, index) => difference(frame, referenceFrames[index]));
}

function popSpike(jumps) {
  let largest = { excess: -Infinity, frame: 0 };
  jumps.forEach((jump, index) => {
    if (index < 3 || index > jumps.length - 4) return;
    const around = jumps.filter((_, other) => other !== index && Math.abs(other - index) <= 3).sort((first, second) => first - second);
    const excess = jump - around[Math.floor(around.length / 2)];
    if (excess > largest.excess) largest = { excess, frame: index + 1 };
  });
  return largest;
}

function popJumps(frames, referenceFrames) {
  const errors = frames.map((frame, index) => difference(frame, referenceFrames[index]));
  const jumps = [];
  for (let index = 1; index < errors.length; index++) {
    const change = difference(errors[index], errors[index - 1]);
    jumps.push(Math.sqrt(change.reduce((sum, value) => sum + value * value, 0) / change.length));
  }
  return jumps;
}

const referenceFrames = await readLumaFrames(referenceDirectory);
const mask = detailMask(referenceFrames);
console.log(JSON.stringify({ directory: referenceDirectory, reference: true, shimmer: Number(shimmer(referenceFrames, mask).toFixed(4)) }));
for (const directory of directoryList.split(',')) {
  const frames = await readLumaFrames(directory);
  if (frames.length !== referenceFrames.length) throw new Error(`${directory} has ${frames.length} frames, the reference ${referenceFrames.length}.`);
  const jumps = popJumps(frames, referenceFrames);
  const sorted = [...jumps].sort((first, second) => first - second);
  const largest = Math.max(...jumps);
  console.log(JSON.stringify({
    directory,
    shimmer: Number(shimmer(frames, mask).toFixed(4)),
    popMax: Number(largest.toFixed(4)),
    popMedian: Number(sorted[Math.floor(sorted.length / 2)].toFixed(4)),
    popMaxFrame: jumps.indexOf(largest) + 1,
    addedShimmer: Number(shimmer(errorFrames(frames, referenceFrames), mask).toFixed(4)),
    popSpike: Number(popSpike(jumps).excess.toFixed(4)),
    popSpikeFrame: popSpike(jumps).frame,
  }));
}
