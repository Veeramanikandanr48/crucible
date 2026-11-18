// Reading and writing whole GLB files for the catalog steps that rewrite one (Draco #1698, KTX2 #1709).

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;

/** Splits a GLB into its JSON document and binary chunk. `subject` names the file kind in the error messages, such as "A Draco GLB". */
export function readGlb(bytes, subject = 'A GLB') {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC || bytes.readUInt32LE(16) !== JSON_CHUNK) {
    throw new Error(`${subject} must be a complete glTF 2.0 binary file.`);
  }
  const version = bytes.readUInt32LE(4);
  if (version !== 2) {
    throw new Error(`${subject} header version is ${version}; pass a glTF 2.0 binary (version 2).`);
  }
  const declaredTotal = bytes.readUInt32LE(8);
  if (declaredTotal !== bytes.length) {
    throw new Error(`${subject} header declares a total length of ${declaredTotal} bytes but the file is ${bytes.length} bytes; pass an undamaged file.`);
  }
  const jsonLength = checkedChunkLength(bytes, 12, 20, 'JSON', subject);
  const document = parseJsonChunk(bytes.subarray(20, 20 + jsonLength), subject);
  const binary = readBinaryChunk(bytes, 20 + jsonLength, subject);
  return { document, binary };
}

/** The declared length of the chunk whose header starts at `headerOffset`, which must be a multiple of 4 and fit before the end of the file. */
function checkedChunkLength(bytes, headerOffset, dataOffset, chunkName, subject) {
  const length = bytes.readUInt32LE(headerOffset);
  if (length % 4 !== 0) {
    throw new Error(`${subject} ${chunkName} chunk declares ${length} bytes, which is not a multiple of 4; pass an undamaged file.`);
  }
  if (dataOffset + length > bytes.length) {
    throw new Error(`${subject} ${chunkName} chunk declares ${length} bytes but only ${bytes.length - dataOffset} remain in the ${bytes.length} byte file; pass an undamaged file.`);
  }
  return length;
}

function parseJsonChunk(chunkBytes, subject) {
  try {
    return JSON.parse(chunkBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${subject} JSON chunk is not valid JSON (${error.message}); pass an undamaged file.`);
  }
}

/** The first binary chunk after the JSON chunk, with every chunk bounds checked and a second binary chunk refused. */
function readBinaryChunk(bytes, firstChunkOffset, subject) {
  let binary = null;
  let offset = firstChunkOffset;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`${subject} has ${bytes.length - offset} stray bytes after its last chunk in the ${bytes.length} byte file; pass an undamaged file.`);
    }
    const isBinary = bytes.readUInt32LE(offset + 4) === BINARY_CHUNK;
    const length = checkedChunkLength(bytes, offset, offset + 8, isBinary ? 'BIN' : 'unknown', subject);
    if (isBinary && binary) {
      throw new Error(`${subject} has a second BIN chunk at byte ${offset}; a GLB holds one, so pass a file with a single binary chunk.`);
    }
    if (isBinary && length === 0) {
      throw new Error(`${subject} BIN chunk declares 0 bytes; pass a file whose binary chunk holds its meshes and images.`);
    }
    if (isBinary) binary = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;
  }
  if (!binary) throw new Error(`${subject} needs a binary chunk that holds its meshes and images.`);
  return binary;
}

/** The buffer padded with `fill` to a multiple of four bytes. */
export function padded(buffer, fill) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
}

/** Writes a GLB from a JSON document and an already padded binary chunk. */
export function writeGlb(document, binary) {
  const json = padded(Buffer.from(JSON.stringify(document)), 0x20);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const result = Buffer.alloc(total);
  result.writeUInt32LE(GLB_MAGIC, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(total, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(JSON_CHUNK, 16);
  json.copy(result, 20);
  const binaryOffset = 20 + json.length;
  result.writeUInt32LE(binary.length, binaryOffset);
  result.writeUInt32LE(BINARY_CHUNK, binaryOffset + 4);
  binary.copy(result, binaryOffset + 8);
  return result;
}
