// Reads a page's Blob into Node as bytes over the DevTools stream protocol (IO.resolveBlob, IO.read).
// A Runtime.evaluate that returns the bytes as a base64 string costs about 12 ms per MB (issue #1861); IO.read of a blob
// handle, in parallel slices, costs about half of that. It opens no listener, so nothing outside the browser connection can
// reach the bytes.

const MAXIMUM_BLOB_BYTES = 2 * 1024 ** 3;
const MINIMUM_SLICE_BYTES = 1024 ** 2;
const MAXIMUM_SLICE_BYTES = 32 * 1024 ** 2;
const PARALLEL_SLICES = 4;

function sliceRanges(byteLength) {
  const sliceBytes = Math.min(MAXIMUM_SLICE_BYTES, Math.max(MINIMUM_SLICE_BYTES, Math.ceil(byteLength / PARALLEL_SLICES)));
  const ranges = [];
  for (let offset = 0; offset < byteLength; offset += sliceBytes) {
    ranges.push({ offset, length: Math.min(sliceBytes, byteLength - offset) });
  }
  return ranges;
}

async function readSlice(session, handle, { offset, length }, bytes) {
  const read = await session.send('IO.read', { handle, offset, size: length });
  const chunk = Buffer.from(read.data, read.base64Encoded ? 'base64' : 'utf8');
  if (chunk.length !== length) {
    throw new RangeError(`readBlobBytes: the browser sent ${chunk.length} bytes at offset ${offset}, expected ${length}. The page changed or released the Blob while it was read.`);
  }
  bytes.set(chunk, offset);
}

/**
 * The `byteLength` bytes of the Blob that `expression` evaluates to in the page of `session` (a CDP session of Playwright or
 * Puppeteer). The slices are read four at a time; a short slice fails with the offset it stopped at.
 */
export async function readBlobBytes(session, expression, byteLength) {
  if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > MAXIMUM_BLOB_BYTES) {
    throw new RangeError(`readBlobBytes: byteLength must be an integer from 0 to ${MAXIMUM_BLOB_BYTES}, got ${JSON.stringify(byteLength)}. Pass the size the page announced for the Blob.`);
  }
  const bytes = new Uint8Array(byteLength);
  if (byteLength === 0) return bytes;
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression });
  if (exceptionDetails || !result?.objectId) {
    throw new TypeError(`readBlobBytes: the expression ${JSON.stringify(expression)} did not evaluate to a Blob${exceptionDetails ? `: ${exceptionDetails.text}` : ''}. Pass an expression that returns a Blob.`);
  }
  let handle;
  try {
    const { uuid } = await session.send('IO.resolveBlob', { objectId: result.objectId });
    handle = `blob:${uuid}`;
    const ranges = sliceRanges(byteLength);
    for (let first = 0; first < ranges.length; first += PARALLEL_SLICES) {
      await Promise.all(ranges.slice(first, first + PARALLEL_SLICES).map(range => readSlice(session, handle, range, bytes)));
    }
  } finally {
    if (handle) await session.send('IO.close', { handle }).catch(() => {});
    await session.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  }
  return bytes;
}
