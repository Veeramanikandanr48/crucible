// Prints the mean luminance of PNG files (display 0 to 255 and linear 0 to 1, Rec. 709 weights) and the RMSE (0 to 255) of
// each file against the first one (issue #1334).
//   node bench/reference/interior-compare.mjs <reference.png> [other.png ...]
import sharp from 'sharp';

const WEIGHTS = [0.2126, 0.7152, 0.0722];

function toLinear(display) {
  const unit = display / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

async function readPixels(path) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, pixelCount: info.width * info.height };
}

function means({ data, pixelCount }) {
  let display = 0;
  let linear = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    let displayLuma = 0;
    let linearLuma = 0;
    for (let channel = 0; channel < 3; channel++) {
      displayLuma += WEIGHTS[channel] * data[pixel * 3 + channel];
      linearLuma += WEIGHTS[channel] * toLinear(data[pixel * 3 + channel]);
    }
    display += displayLuma;
    linear += linearLuma;
  }
  return { display: display / pixelCount, linear: linear / pixelCount };
}

function rmse(first, second) {
  if (first.pixelCount !== second.pixelCount) return NaN;
  let total = 0;
  for (let index = 0; index < first.data.length; index++) total += (first.data[index] - second.data[index]) ** 2;
  return Math.sqrt(total / first.data.length);
}

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error('Pass at least one PNG path: node bench/reference/interior-compare.mjs <reference.png> [other.png ...]');
const reference = await readPixels(paths[0]);
for (const path of paths) {
  const image = path === paths[0] ? reference : await readPixels(path);
  const { display, linear } = means(image);
  console.log(`${path}  display ${display.toFixed(2)}  linear ${linear.toFixed(4)}  rmse-vs-first ${rmse(reference, image).toFixed(2)}`);
}
