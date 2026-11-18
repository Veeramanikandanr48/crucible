import { deflateSync } from 'node:zlib';

import { PNG_SIGNATURE, pngChunk } from '../src/export-png.js';
import { cryptomatteByte, cryptomatteMatte, floatPassToBytes, objectIdMatte } from '../src/pass-compositing.js';

// The ID mattes of a render job (settings.mattes): one gray PNG per matte, white where the named part or material is drawn.
// Parts come from the exact 24-bit object ID pass, materials from the Cryptomatte pass (an 8-bit hash that two names can share).

const NAMES_IN_ERROR = 20;
const PNG_GRAY_COLOR_TYPE = 0;

/** An 8-bit gray PNG of a 0/255 mask (one byte per pixel, top row first), deflated: a matte is mostly flat runs, so it stays small at 4K. */
export function encodeMattePng(mask, width, height) {
  if (mask.length !== width * height) throw new RangeError('The mask needs one byte per pixel at the frame size.');
  const rows = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row++) Buffer.from(mask.buffer, mask.byteOffset + row * width, width).copy(rows, row * (width + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = PNG_GRAY_COLOR_TYPE;
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows, { level: 6 })), pngChunk('IEND', new Uint8Array(0))]);
}

function nameList(names) {
  const shown = names.slice(0, NAMES_IN_ERROR).join(', ');
  return names.length > NAMES_IN_ERROR ? `${shown}, and ${names.length - NAMES_IN_ERROR} more` : shown;
}

function coverageOf(mask) {
  let covered = 0;
  for (const value of mask) if (value) covered++;
  return covered;
}

function objectMatte({ target, index, objectPass }) {
  const ids = [];
  objectPass.info.objectNames.forEach((name, position) => { if (name === target) ids.push(position + 1); });
  if (ids.length === 0) {
    throw new Error(`mattes[${index}]: no part named "${target}" in this scene. Pass one of: ${nameList(objectPass.info.objectNames)}.`);
  }
  const mask = objectIdMatte({ pixels: objectPass.bytes, width: objectPass.width, height: objectPass.height, ids });
  return { mask, metric: { object: target, partIds: ids } };
}

function materialMatte({ target, index, cryptomattePass }) {
  const { materials } = cryptomattePass.info.cryptomatte;
  const entry = materials[target];
  if (!entry) {
    throw new Error(`mattes[${index}]: no material named "${target}" in this scene. Pass one of: ${nameList(Object.keys(materials))}.`);
  }
  const mask = cryptomatteMatte({ pixels: cryptomattePass.bytes, width: cryptomattePass.width, height: cryptomattePass.height, channel: 'material', value: entry.value });
  const sharedWith = Object.entries(materials)
    .filter(([name, other]) => name !== target && cryptomatteByte(other.value) === cryptomatteByte(entry.value))
    .map(([name]) => name);
  return { mask, metric: { material: target, ...(sharedWith.length ? { sharedWith } : {}) } };
}

/**
 * Renders the passes the mattes need through `renderPass(name)` (which returns `{ info, pixels, width, height }`, the pass info and the
 * float readback of the frame) and returns `[{ bytes, metric }]` in the order of `mattes`: the PNG file and what to report in the job metrics.
 */
export async function renderJobMattes({ mattes, renderPass }) {
  const passes = new Map();
  async function passBytes(name) {
    if (!passes.has(name)) {
      const pass = await renderPass(name);
      passes.set(name, { info: pass.info, width: pass.width, height: pass.height, bytes: floatPassToBytes(pass) });
    }
    return passes.get(name);
  }
  const results = [];
  for (const [index, matte] of mattes.entries()) {
    const built = matte.object !== undefined
      ? objectMatte({ target: matte.object, index, objectPass: await passBytes('objectId') })
      : materialMatte({ target: matte.material, index, cryptomattePass: await passBytes('cryptomatte') });
    const { width, height } = passes.get(matte.object !== undefined ? 'objectId' : 'cryptomatte');
    results.push({
      bytes: encodeMattePng(built.mask, width, height),
      metric: { ...built.metric, coveragePixels: coverageOf(built.mask) },
    });
  }
  return results;
}
