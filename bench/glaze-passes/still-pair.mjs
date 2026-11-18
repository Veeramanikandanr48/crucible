// Compares two frames written by run.mjs with "capture":true and writes the pictures for a pull request:
// node bench/glaze-passes/still-pair.mjs <off.rgba> <on.rgba> <output-prefix> [width] [height]
// Prints the whole-frame RMSE over RGB (0 to 255) and the 64 x 64 window with the largest RMSE, and writes
// <prefix>-off.png, <prefix>-on.png, <prefix>-diff-x8.png and <prefix>-crop-off-left-on-right.png (that window at 2x).
import { readFile, writeFile } from 'node:fs/promises';
import { encodePng } from './png.mjs';

const [offFile, onFile, prefix, widthText = '1280', heightText = '720'] = process.argv.slice(2);
if (!offFile || !onFile || !prefix) throw new Error('Pass the off .rgba file, the on .rgba file and an output prefix.');
const width = Number(widthText);
const height = Number(heightText);
const windowSize = 64;
const off = await readFile(offFile);
const on = await readFile(onFile);
if (off.length !== on.length || off.length !== width * height * 4) throw new Error(`Both frames must be ${width} x ${height} RGBA, ${width * height * 4} bytes.`);

const squaredSums = new Float64Array((width + 1) * (height + 1));
const difference = Buffer.alloc(off.length);
let total = 0;
for (let y = 0; y < height; y++) {
  let rowSum = 0;
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    let pixel = 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = off[offset + channel] - on[offset + channel];
      pixel += delta * delta;
      difference[offset + channel] = Math.min(255, Math.abs(delta) * 8);
    }
    difference[offset + 3] = 255;
    total += pixel;
    rowSum += pixel;
    squaredSums[(y + 1) * (width + 1) + x + 1] = squaredSums[y * (width + 1) + x + 1] + rowSum;
  }
}
let worst = { rmse: -1, x: 0, y: 0 };
for (let y = 0; y + windowSize <= height; y += 4) {
  for (let x = 0; x + windowSize <= width; x += 4) {
    const sum = squaredSums[(y + windowSize) * (width + 1) + x + windowSize] - squaredSums[y * (width + 1) + x + windowSize]
      - squaredSums[(y + windowSize) * (width + 1) + x] + squaredSums[y * (width + 1) + x];
    const rmse = Math.sqrt(sum / (windowSize * windowSize * 3));
    if (rmse > worst.rmse) worst = { rmse, x, y };
  }
}
const cropWidth = windowSize * 4 + 8;
const cropHeight = windowSize * 2;
const crop = Buffer.alloc(cropWidth * cropHeight * 4, 255);
for (let row = 0; row < cropHeight; row++) {
  for (let column = 0; column < cropWidth; column++) {
    const inOff = column < windowSize * 2;
    const inOn = column >= windowSize * 2 + 8;
    if (!inOff && !inOn) continue;
    const localX = (inOff ? column : column - windowSize * 2 - 8) >> 1;
    const topY = worst.y + ((cropHeight - 1 - row) >> 1);
    const source = ((height - 1 - topY) * width + worst.x + localX) * 4;
    crop.set((inOff ? off : on).subarray(source, source + 4), (row * cropWidth + column) * 4);
  }
}
const opaque = frame => frame.map((value, index) => (index % 4 === 3 ? 255 : value));
await writeFile(`${prefix}-off.png`, encodePng(opaque(off), width));
await writeFile(`${prefix}-on.png`, encodePng(opaque(on), width));
await writeFile(`${prefix}-diff-x8.png`, encodePng(difference, width));
await writeFile(`${prefix}-crop-off-left-on-right.png`, encodePng(crop, cropWidth));
console.log(JSON.stringify({ rmse: Number(Math.sqrt(total / (width * height * 3)).toFixed(3)), worstWindow: { x: worst.x, y: worst.y, rmse: Number(worst.rmse.toFixed(3)) } }));
