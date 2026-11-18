// Prints the mean red, green and blue (display 0 to 255) of named regions of the window room probe's 960x540 frame, for each PNG
// given, with the whole-frame RMSE against the first one (issue #1334, #2160). The first file is the reference (the path tracer).
//   node bench/reference/interior-regions.mjs <reference.png> [other.png ...]
import sharp from 'sharp';

const FRAME_WIDTH = 960;
const FRAME_HEIGHT = 540;

// Boxes `[left, top, right, bottom]` in pixels of interior-exposure.mjs's default camera. The floor boxes leave out the sunlit patch.
export const REGIONS = {
  'left wall': [20, 130, 150, 270],
  'back wall': [300, 190, 660, 320],
  'right wall': [800, 150, 940, 280],
  'ceiling': [250, 5, 700, 110],
  'floor': [20, 440, 380, 535],
  'sunlit floor': [540, 475, 840, 530],
  'wall-floor corner': [260, 326, 700, 344],
  'wall-ceiling corner': [260, 156, 700, 174],
};

async function readPixels(path) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== FRAME_WIDTH || info.height !== FRAME_HEIGHT) throw new Error(`${path} is ${info.width}x${info.height}; render the probe at ${FRAME_WIDTH}x${FRAME_HEIGHT} (the default).`);
  return data;
}

export function regionMeans(data, [left, top, right, bottom]) {
  const totals = [0, 0, 0];
  let count = 0;
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      for (let channel = 0; channel < 3; channel++) totals[channel] += data[(row * FRAME_WIDTH + column) * 3 + channel];
      count++;
    }
  }
  return totals.map(total => total / count);
}

function rmse(first, second) {
  let total = 0;
  for (let index = 0; index < first.length; index++) total += (first[index] - second[index]) ** 2;
  return Math.sqrt(total / first.length);
}

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error('Pass at least one PNG path: node bench/reference/interior-regions.mjs <reference.png> [other.png ...]');
const images = await Promise.all(paths.map(readPixels));
for (const [index, path] of paths.entries()) {
  console.log(`${path}  rmse-vs-first ${rmse(images[0], images[index]).toFixed(2)}`);
  for (const [name, box] of Object.entries(REGIONS)) {
    const [red, green, blue] = regionMeans(images[index], box);
    console.log(`  ${name.padEnd(20)} R ${red.toFixed(1).padStart(6)}  G ${green.toFixed(1).padStart(6)}  B ${blue.toFixed(1).padStart(6)}`);
  }
}
