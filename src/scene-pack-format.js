// The file format of `crucible pack` (docs/pack.md): a compiled scene as one JSON header plus one binary block.
// This module is shared by the Node compiler (src/scene-pack.js) and the web runtime (src/crucible-scene.js), so it imports
// nothing: the runtime must not pull any agent-scene code through it.

export const PACK_FORMAT = 'crucible.pack';
export const PACK_VERSION = 1;

const TYPED_ARRAYS = Object.freeze({
  Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
});
const TYPED_MARKER = '$typed';
const ALIGNMENT = 4;
const HEADER_BYTES = 8;
const MAGIC = 0x4b435243; // "CRCK" read as little endian

function padTo(length, alignment) {
  return Math.ceil(length / alignment) * alignment;
}

function describeKind(value) {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/**
 * Splits a value into JSON and binary: every typed array becomes a { $typed, offset, length } marker and its bytes go to
 * the binary block, so geometry is never written as text. Anything JSON cannot hold throws and names where it sits.
 */
function encodeValue(value, path, chunks, cursor) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: got ${value}; expected a finite number. Fix the recipe field that produced it.`);
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const name = value.constructor.name;
    if (!Object.hasOwn(TYPED_ARRAYS, name)) throw new TypeError(`${path}: got ${name}; expected a typed array such as Float32Array or Uint32Array.`);
    const offset = padTo(cursor.bytes, ALIGNMENT);
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    chunks.push({ offset, bytes });
    cursor.bytes = offset + bytes.byteLength;
    return { [TYPED_MARKER]: name, offset, length: value.length };
  }
  if (Array.isArray(value)) return value.map((entry, index) => encodeValue(entry, `${path}[${index}]`, chunks, cursor));
  if (value !== undefined && typeof value === 'object') {
    const kind = describeKind(value);
    if (kind !== 'Object') throw new TypeError(`${path}: got a ${kind}; expected plain data. A pack holds numbers, strings, arrays, objects and typed arrays only.`);
    const encoded = {};
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) encoded[key] = encodeValue(value[key], `${path}.${key}`, chunks, cursor);
    }
    return encoded;
  }
  throw new TypeError(`${path}: got ${typeof value}; expected plain data. A pack holds numbers, strings, arrays, objects and typed arrays only.`);
}

function decodeValue(value, binary) {
  if (Array.isArray(value)) return value.map(entry => decodeValue(entry, binary));
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, TYPED_MARKER)) {
    const Constructor = TYPED_ARRAYS[value[TYPED_MARKER]];
    if (!Constructor) throw new TypeError(`pack: unknown typed array "${value[TYPED_MARKER]}"; repack the scene with this version of crucible pack.`);
    return new Constructor(binary.buffer, binary.byteOffset + value.offset, value.length);
  }
  const decoded = {};
  for (const key of Object.keys(value)) decoded[key] = decodeValue(value[key], binary);
  return decoded;
}

/** Encodes a scene description into one deterministic Uint8Array: the same input always gives the same bytes. */
export function encodePack(scene) {
  if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
    throw new TypeError('encodePack: pass the scene object to pack, such as { camera, environment, parts }.');
  }
  const chunks = [];
  const cursor = { bytes: 0 };
  const body = encodeValue(scene, 'scene', chunks, cursor);
  const header = new TextEncoder().encode(JSON.stringify({ format: PACK_FORMAT, version: PACK_VERSION, scene: body }));
  const binaryStart = padTo(HEADER_BYTES + header.length, ALIGNMENT);
  const output = new Uint8Array(binaryStart + cursor.bytes);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.length, true);
  output.set(header, HEADER_BYTES);
  for (const { offset, bytes } of chunks) output.set(bytes, binaryStart + offset);
  return output;
}

/** Reads what encodePack wrote. Typed arrays are views on `bytes`, so the caller must keep it alive. */
export function decodePack(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodePack: pass the bytes of a .pack file as an ArrayBuffer or Uint8Array.');
  if (bytes.length < HEADER_BYTES || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== MAGIC) {
    throw new TypeError('decodePack: these bytes are not a crucible pack. Pass a file written by `crucible pack`.');
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (HEADER_BYTES + headerLength > bytes.length) throw new TypeError('decodePack: the pack is cut short. Download or copy it again.');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + headerLength)));
  if (header.format !== PACK_FORMAT || header.version !== PACK_VERSION) {
    throw new TypeError(`decodePack: got ${header.format} version ${header.version}; expected ${PACK_FORMAT} version ${PACK_VERSION}. Repack the scene with this version of crucible pack.`);
  }
  const binaryStart = padTo(HEADER_BYTES + headerLength, ALIGNMENT);
  // The typed array views need a 4 byte aligned buffer offset, so a pack read from an odd offset is copied once.
  const aligned = (bytes.byteOffset + binaryStart) % ALIGNMENT === 0 ? bytes.subarray(binaryStart) : bytes.slice(binaryStart);
  return decodeValue(header.scene, aligned);
}
