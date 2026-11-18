import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Decodes EXT_meshopt_compression buffer views with the meshoptimizer WebAssembly decoder (MIT, the build that ships with three.js).
// Only a file that has such a view loads this module, so the decoder costs every other file nothing.
const MODES = new Set(['ATTRIBUTES', 'TRIANGLES', 'INDICES']);
const FILTERS = new Set(['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL']);

function fieldPath(viewIndex, field) {
  return `bufferViews[${viewIndex}].extensions.EXT_meshopt_compression.${field}`;
}

function requireInteger(value, viewIndex, field, minimum, expectation) {
  if (Number.isSafeInteger(value) && value >= minimum) return value;
  throw new Error(`Invalid glTF ${fieldPath(viewIndex, field)} ${JSON.stringify(value)}: expected ${expectation}.`);
}

function requireOneOf(value, allowed, viewIndex, field) {
  if (allowed.has(value)) return value;
  throw new Error(`Invalid glTF ${fieldPath(viewIndex, field)} ${JSON.stringify(value)}: expected one of ${[...allowed].join(', ')}.`);
}

function requireStrideForMode(byteStride, mode, viewIndex) {
  const attributeStride = mode === 'ATTRIBUTES';
  const allowed = attributeStride
    ? Number.isSafeInteger(byteStride) && byteStride >= 4 && byteStride <= 256 && byteStride % 4 === 0
    : byteStride === 2 || byteStride === 4;
  if (allowed) return;
  const expectation = attributeStride ? 'a multiple of 4 from 4 to 256 for ATTRIBUTES' : `2 or 4 for ${mode}`;
  throw new Error(`Invalid glTF ${fieldPath(viewIndex, 'byteStride')} ${JSON.stringify(byteStride)}: expected ${expectation}.`);
}

/** Checks every field the meshoptimizer decoder needs, so a bad file fails with the field and the allowed values instead of "Malformed buffer data". */
function validateExtension(extension, viewIndex) {
  requireOneOf(extension.mode, MODES, viewIndex, 'mode');
  requireOneOf(extension.filter ?? 'NONE', FILTERS, viewIndex, 'filter');
  requireInteger(extension.byteOffset ?? 0, viewIndex, 'byteOffset', 0, 'a non-negative safe integer');
  requireInteger(extension.byteLength, viewIndex, 'byteLength', 1, 'a positive safe integer');
  requireInteger(extension.count, viewIndex, 'count', 1, 'a positive safe integer');
  requireStrideForMode(extension.byteStride, extension.mode, viewIndex);
  if (extension.mode === 'TRIANGLES' && extension.count % 3 !== 0) {
    throw new Error(`Invalid glTF ${fieldPath(viewIndex, 'count')} ${extension.count}: expected a multiple of 3 for TRIANGLES.`);
  }
}

function decodeView(view, viewIndex, bufferBytes, decoder) {
  const extension = view.extensions.EXT_meshopt_compression;
  validateExtension(extension, viewIndex);
  const filter = extension.filter ?? 'NONE';
  const source = bufferBytes(extension.buffer);
  const offset = extension.byteOffset ?? 0;
  if (!source || offset + extension.byteLength > source.length) throw new Error('Meshopt buffer view exceeds its buffer.');
  const decodedLength = extension.count * extension.byteStride;
  if (!Number.isSafeInteger(decodedLength) || decodedLength !== view.byteLength) {
    throw new Error('EXT_meshopt_compression count and byteStride do not match the buffer view length.');
  }
  const decoded = new Uint8Array(decodedLength);
  try {
    decoder.decodeGltfBuffer(decoded, extension.count, extension.byteStride, source.subarray(offset, offset + extension.byteLength), extension.mode, filter);
  } catch (error) {
    throw new Error(`EXT_meshopt_compression could not decode a buffer view (${extension.mode}, ${filter}): ${error.message}`);
  }
  return decoded;
}

/** Returns a Map from buffer view index to its decoded bytes. The fallback buffer is never read. A view in `skippedViews` decodes to no bytes. */
export async function decodeMeshoptViews(bufferViews, bufferBytes, suppliedDecoder, skippedViews = new Set()) {
  const decoder = suppliedDecoder ?? MeshoptDecoder;
  await decoder.ready;
  const decodedViews = new Map();
  bufferViews.forEach((view, index) => {
    if (!view.extensions?.EXT_meshopt_compression) return;
    decodedViews.set(index, skippedViews.has(index) ? new Uint8Array(0) : decodeView(view, index, bufferBytes, decoder));
  });
  return decodedViews;
}
