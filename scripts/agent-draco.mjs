import { createRequire } from 'node:module';
import { AGENT_ASSET_LIMITS } from '../src/agent-asset-limits.js';
import { padded, readGlb, writeGlb } from './agent-glb-io.mjs';

// Draco-compressed GLBs through MCP (#1698). The preview page cannot be handed a Draco decoder by an agent, so the server
// decompresses the file as it reads it from the catalog: every primitive's attributes and indices are decoded with the
// optional draco3d package and written as plain buffer views, and the extension is dropped. The page then loads an ordinary
// GLB. draco3d is an optional peer dependency and loads only when a file uses the extension.

export const DRACO_EXTENSION = 'KHR_draco_mesh_compression';

const ARRAY_TYPES = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COMPONENTS_PER_TYPE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const UNSIGNED_INT = 5125;

export const DRACO_MISSING_ADVICE = 'Install the optional decoder where the MCP server runs (npm install draco3d) and call again, or re-export the GLB without Draco compression (in Blender, untick Compression in the glTF export).';

/** Whether a glTF document lists the Draco extension. */
export function usesDraco(document) {
  return [document?.extensionsUsed, document?.extensionsRequired].some(list => Array.isArray(list) && list.includes(DRACO_EXTENSION));
}

let defaultDecoderModule = null;

/** The draco3d decoder module, created once per process. Throws an error that says how to install it when it is missing. */
export function loadDefaultDracoDecoder() {
  if (!defaultDecoderModule) {
    let draco;
    try {
      draco = createRequire(import.meta.url)('draco3d');
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
      throw new Error(`This GLB uses ${DRACO_EXTENSION} and the draco3d decoder is not installed. ${DRACO_MISSING_ADVICE}`);
    }
    defaultDecoderModule = Promise.resolve(draco.createDecoderModule({}));
  }
  return defaultDecoderModule;
}

function dracoDataType(draco, ArrayType) {
  const types = new Map([[Float32Array, draco.DT_FLOAT32], [Int8Array, draco.DT_INT8], [Uint8Array, draco.DT_UINT8],
    [Int16Array, draco.DT_INT16], [Uint16Array, draco.DT_UINT16], [Uint32Array, draco.DT_UINT32]]);
  return types.get(ArrayType);
}

// A Draco stream states its own point and face counts. Before the decoder heap gets a buffer sized from one of them, the count
// must match the accessor the glTF declares and the buffer must fit the asset byte limit (#1913).
function assertClaimedCount(label, what, claimedCount, declaredCount) {
  if (claimedCount !== declaredCount) {
    throw new Error(`${label}: the Draco data holds ${claimedCount} ${what} but its accessor declares count ${declaredCount}. Re-export the GLB; the file is damaged or was edited.`);
  }
}

function assertBufferFitsLimit(label, what, byteLength, maximumBytes) {
  if (byteLength > maximumBytes) {
    throw new RangeError(`${label}: decoding the Draco ${what} needs ${byteLength} bytes, over the ${maximumBytes} byte asset limit. Re-export a smaller mesh.`);
  }
}

function copyFromHeap(draco, ArrayType, pointer, count) {
  return new ArrayType(draco.HEAPU8.buffer, pointer, count).slice();
}

function decodeAttribute(draco, decoder, mesh, uniqueId, accessor, label, maximumBytes) {
  const attribute = decoder.GetAttributeByUniqueId(mesh, uniqueId);
  if (!attribute || attribute.ptr === 0) throw new Error(`${label}: the Draco data has no attribute with id ${uniqueId}.`);
  const ArrayType = ARRAY_TYPES[accessor.componentType];
  const components = COMPONENTS_PER_TYPE[accessor.type];
  if (!ArrayType || !components) throw new Error(`${label}: accessor componentType ${accessor.componentType} or type ${accessor.type} is not a glTF vertex format.`);
  assertClaimedCount(label, 'points', mesh.num_points(), accessor.count);
  const count = mesh.num_points() * components;
  const byteLength = count * ArrayType.BYTES_PER_ELEMENT;
  assertBufferFitsLimit(label, 'attribute', byteLength, maximumBytes);
  const pointer = draco._malloc(byteLength);
  try {
    if (!decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, dracoDataType(draco, ArrayType), byteLength, pointer)) {
      throw new Error(`${label}: Draco could not read the attribute as ${ArrayType.name}.`);
    }
    return copyFromHeap(draco, ArrayType, pointer, count);
  } finally {
    draco._free(pointer);
  }
}

function decodeIndices(draco, decoder, mesh, accessor, label, maximumBytes) {
  assertClaimedCount(label, 'face indices', mesh.num_faces() * 3, accessor.count);
  const count = mesh.num_faces() * 3;
  const byteLength = count * 4;
  assertBufferFitsLimit(label, 'indices', byteLength, maximumBytes);
  const pointer = draco._malloc(byteLength);
  try {
    decoder.GetTrianglesUInt32Array(mesh, byteLength, pointer);
    return copyFromHeap(draco, Uint32Array, pointer, count);
  } finally {
    draco._free(pointer);
  }
}

/** Decodes one primitive and returns the arrays to write, keyed by accessor index. */
function decodePrimitive(draco, primitive, document, binary, label, maximumBytes) {
  const extension = primitive.extensions[DRACO_EXTENSION];
  const view = document.bufferViews?.[extension.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) throw new Error(`${label}: the Draco bufferView ${extension.bufferView} must point into the GLB's binary chunk.`);
  const start = view.byteOffset ?? 0;
  if (start + view.byteLength > binary.length) throw new Error(`${label}: the Draco bufferView ${extension.bufferView} runs past the binary chunk.`);
  const compressed = new Int8Array(binary.buffer, binary.byteOffset + start, view.byteLength);
  const decoder = new draco.Decoder();
  const mesh = new draco.Mesh();
  try {
    if (decoder.GetEncodedGeometryType(compressed) !== draco.TRIANGULAR_MESH) throw new Error(`${label}: only Draco triangle meshes are supported, not point clouds.`);
    const status = decoder.DecodeArrayToMesh(compressed, compressed.byteLength, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error(`${label}: Draco decoding failed (${status.error_msg()}). The file may be damaged; re-export it.`);
    const decoded = new Map();
    for (const [semantic, uniqueId] of Object.entries(extension.attributes ?? {})) {
      const accessorIndex = primitive.attributes[semantic];
      const accessor = document.accessors?.[accessorIndex];
      if (!accessor) throw new Error(`${label}: attribute ${semantic} has no accessor.`);
      decoded.set(accessorIndex, { values: decodeAttribute(draco, decoder, mesh, uniqueId, accessor, `${label} ${semantic}`, maximumBytes), count: mesh.num_points() });
    }
    if (primitive.indices !== undefined) {
      const indicesAccessor = document.accessors?.[primitive.indices];
      if (!indicesAccessor) throw new Error(`${label}: the indices accessor ${primitive.indices} does not exist.`);
      const indices = decodeIndices(draco, decoder, mesh, indicesAccessor, `${label} indices`, maximumBytes);
      decoded.set(primitive.indices, { values: indices, count: indices.length, componentType: UNSIGNED_INT });
    }
    return decoded;
  } finally {
    draco.destroy(mesh);
    draco.destroy(decoder);
  }
}

function withoutDracoExtension(list) {
  if (!Array.isArray(list)) return list;
  const kept = list.filter(name => name !== DRACO_EXTENSION);
  return kept.length ? kept : undefined;
}

/**
 * Returns the GLB with every Draco primitive decoded into plain buffer views and the extension removed. The compressed
 * buffer views stay in the binary chunk, unreferenced. `loadDecoder` returns the draco3d decoder module; `maximumBytes` bounds each decoded buffer.
 */
export async function decompressDracoGlb(bytes, { filename = 'GLB', loadDecoder = loadDefaultDracoDecoder, maximumBytes = AGENT_ASSET_LIMITS.maxBytes } = {}) {
  const { document, binary } = readGlb(bytes, 'A Draco GLB');
  const draco = await loadDecoder();
  const chunks = [padded(Buffer.from(binary), 0)];
  let size = chunks[0].length;
  const written = new Set();
  let primitiveCount = 0;
  for (const [meshIndex, mesh] of (document.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      if (!primitive.extensions?.[DRACO_EXTENSION]) continue;
      const label = `${filename} mesh ${meshIndex} primitive ${primitiveIndex}`;
      for (const [accessorIndex, { values, count, componentType }] of decodePrimitive(draco, primitive, document, binary, label, maximumBytes)) {
        if (written.has(accessorIndex)) continue;
        written.add(accessorIndex);
        const chunk = padded(Buffer.from(values.buffer, values.byteOffset, values.byteLength), 0);
        document.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: values.byteLength });
        const accessor = document.accessors[accessorIndex];
        accessor.bufferView = document.bufferViews.length - 1;
        delete accessor.byteOffset;
        accessor.count = count;
        if (componentType !== undefined) accessor.componentType = componentType;
        chunks.push(chunk);
        size += chunk.length;
      }
      delete primitive.extensions[DRACO_EXTENSION];
      if (Object.keys(primitive.extensions).length === 0) delete primitive.extensions;
      primitiveCount++;
    }
  }
  for (const listName of ['extensionsUsed', 'extensionsRequired']) {
    const kept = withoutDracoExtension(document[listName]);
    if (kept === undefined) delete document[listName];
    else document[listName] = kept;
  }
  document.buffers[0].byteLength = size;
  return { bytes: writeGlb(document, Buffer.concat(chunks)), primitives: primitiveCount };
}
