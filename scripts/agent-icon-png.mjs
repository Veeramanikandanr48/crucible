// 8-bit RGBA PNG reading and writing for the icons job: decode a browser screenshot, copy icons into an atlas, encode both.
// The encoder is plain deflate at a fixed level, so the same pixels always give the same bytes.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAXIMUM_PIXELS = 4096 * 4096;
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let value = byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    table[byte] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 'latin1');
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length);
  return output;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/** The pixels of an 8-bit RGB or RGBA PNG without interlacing, as RGBA bytes row by row. Anything else throws. */
export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file.');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`The icons job reads 8-bit RGB or RGBA PNGs without interlacing; got bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}.`);
  }
  if (!width || !height || width * height > MAXIMUM_PIXELS) throw new Error(`PNG size ${width}x${height} is outside the icons job limit.`);
  const data = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('PNG pixel data has the wrong length.');
  const rgba = Buffer.alloc(width * height * 4, 255);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    for (let index = 0; index < stride; index++) {
      const value = raw[row * (stride + 1) + 1 + index];
      const left = index >= channels ? current[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      if (filter > 4) throw new Error(`PNG row ${row} has the unknown filter ${filter}.`);
      current[index] = (value + predicted) & 255;
    }
    for (let column = 0; column < width; column++) {
      for (let channel = 0; channel < channels; channel++) rgba[(row * width + column) * 4 + channel] = current[column * channels + channel];
    }
    current.copy(previous);
  }
  return { width, height, data: rgba };
}

/** An 8-bit RGBA PNG of the pixels. The same pixels always give the same bytes. */
export function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Copies `source` into `atlas` with its top left corner at (x, y). */
export function copyIntoAtlas(atlas, source, x, y) {
  for (let row = 0; row < source.height; row++) {
    const from = row * source.width * 4;
    source.data.copy(atlas.data, ((y + row) * atlas.width + x) * 4, from, from + source.width * 4);
  }
}

export function blankImage(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}
