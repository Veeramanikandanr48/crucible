// Turns the displayed RGBA floats written by capture-volume-edge.mjs into scene-linear RGB floats (undoes the view transform and the 1 / 2.2 gamma) and flips them to row 0 at the top.
// Run from the repository root: node bench/cycles-parity/linearize-display-floats.mjs --width 960 --height 540 [--view-transform aces] <file.f32>...
// Writes <file>-linear.f32 beside each input.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { applyViewTransform } from '../../src/view-transform.js';

const LOOKUP_SIZE = 4096;
const SEARCH_ROUNDS = 40;
const SEARCH_CEILING = 64;
const DISPLAY_GAMMA = 2.2;
const INPUT_CHANNELS = 4;
const OUTPUT_CHANNELS = 3;

function parseCommandLine() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      width: { type: 'string' },
      height: { type: 'string' },
      'view-transform': { type: 'string', default: 'aces' },
    },
  });
  const width = Number(values.width);
  const height = Number(values.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || positionals.length === 0) {
    throw new Error('pass --width <pixels> --height <pixels> and one or more .f32 files written by capture-volume-edge.mjs');
  }
  return { width, height, viewTransform: values['view-transform'], paths: positionals };
}

function buildDisplayToLinearTable(viewTransform) {
  const table = new Float64Array(LOOKUP_SIZE + 1);
  for (let entry = 0; entry <= LOOKUP_SIZE; entry++) {
    const displayed = entry / LOOKUP_SIZE;
    let low = 0;
    let high = SEARCH_CEILING;
    for (let round = 0; round < SEARCH_ROUNDS; round++) {
      const middle = (low + high) / 2;
      const shown = applyViewTransform(viewTransform, [middle, middle, middle])[0] ** (1 / DISPLAY_GAMMA);
      if (shown < displayed) low = middle;
      else high = middle;
    }
    table[entry] = low;
  }
  return table;
}

function lookUpLinear(table, displayed) {
  const position = Math.min(1, Math.max(0, displayed)) * LOOKUP_SIZE;
  const lower = Math.floor(position);
  const upper = Math.min(LOOKUP_SIZE, lower + 1);
  return table[lower] + (table[upper] - table[lower]) * (position - lower);
}

function linearizeFile(path, table, width, height) {
  const buffer = readFileSync(path);
  const source = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const expectedValues = width * height * INPUT_CHANNELS;
  if (source.length !== expectedValues) {
    throw new Error(`${path} holds ${source.length} floats but ${width} x ${height} RGBA needs ${expectedValues}; pass the size the frame was captured at`);
  }
  const result = new Float32Array(width * height * OUTPUT_CHANNELS);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const from = ((height - 1 - row) * width + column) * INPUT_CHANNELS;
      const to = (row * width + column) * OUTPUT_CHANNELS;
      for (let channel = 0; channel < OUTPUT_CHANNELS; channel++) {
        result[to + channel] = lookUpLinear(table, source[from + channel]);
      }
    }
  }
  writeFileSync(path.replace('.f32', '-linear.f32'), Buffer.from(result.buffer));
}

const { width, height, viewTransform, paths } = parseCommandLine();
const table = buildDisplayToLinearTable(viewTransform);
for (const path of paths) linearizeFile(path, table, width, height);
