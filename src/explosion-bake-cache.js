import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readEnvironmentVariable } from './environment-variable.js';

// Keeps the baked frames of add-explosion on disk (#1768), so the second MCP process that needs the same blast reads about 30 MB instead of
// simulating for 5 seconds. Node only: explosion-grids.js reaches it through setExplosionBakeStore, and the preview page never loads this file.
// The MCP server installs it; a library user gets no cache unless they call installExplosionBakeCache themselves.

export const BAKE_CACHE_VARIABLE = 'BAKE_CACHE';
export const BAKE_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const FILE_MAGIC = 'CBK1';
const HEADER_FIXED_BYTES = 4 + 4 + 32;
const FILE_NAME = /^bake-[a-z]+-\d+-(?:velocity|plain)-[0-9a-f]{16}\.bin$/;

/** The cache folder: CRUCIBLE_BAKE_CACHE (an absolute folder, or "off"), else `crucible/explosion-bakes` in the user's cache folder. Null when off. */
export function bakeCacheDirectory(env = process.env, platform = process.platform) {
  const configured = readEnvironmentVariable(BAKE_CACHE_VARIABLE, env);
  if (configured === 'off') return null;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error(`CRUCIBLE_BAKE_CACHE must be an absolute folder or "off", got "${configured}".`);
    return configured;
  }
  const base = env.XDG_CACHE_HOME || (platform === 'win32' && env.LOCALAPPDATA ? env.LOCALAPPDATA : join(homedir(), '.cache'));
  return join(base, 'crucible', 'explosion-bakes');
}

function fileNameFor(descriptor) {
  const parameterHash = createHash('sha256').update(JSON.stringify([descriptor.version, descriptor.parameters])).digest('hex').slice(0, 16);
  return `bake-${descriptor.fuel}-${descriptor.seed}-${descriptor.velocity ? 'velocity' : 'plain'}-${parameterHash}.bin`;
}

// Layout: magic, frame count (u32), SHA-256 of everything after the header, then one u32 length per frame, then the frames back to back.
function encodeBake(frames) {
  const tableBytes = frames.length * 4;
  const bodyBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
  const file = Buffer.alloc(HEADER_FIXED_BYTES + tableBytes + bodyBytes);
  file.write(FILE_MAGIC, 0, 'latin1');
  file.writeUInt32LE(frames.length, 4);
  let offset = HEADER_FIXED_BYTES;
  frames.forEach(frame => {
    file.writeUInt32LE(frame.byteLength, offset);
    offset += 4;
  });
  frames.forEach(frame => {
    file.set(frame, offset);
    offset += frame.byteLength;
  });
  createHash('sha256').update(file.subarray(HEADER_FIXED_BYTES)).digest().copy(file, 8);
  return file;
}

/** The frames in `file`, or null when it is truncated, has another layout or fails its checksum. */
export function decodeBake(file, expectedFrames) {
  if (file.length < HEADER_FIXED_BYTES || file.toString('latin1', 0, 4) !== FILE_MAGIC) return null;
  const count = file.readUInt32LE(4);
  if (count !== expectedFrames || file.length < HEADER_FIXED_BYTES + count * 4) return null;
  const checksum = createHash('sha256').update(file.subarray(HEADER_FIXED_BYTES)).digest();
  if (!checksum.equals(file.subarray(8, 8 + 32))) return null;
  const frames = [];
  let tableOffset = HEADER_FIXED_BYTES;
  let bodyOffset = HEADER_FIXED_BYTES + count * 4;
  for (let index = 0; index < count; index += 1) {
    const length = file.readUInt32LE(tableOffset);
    tableOffset += 4;
    if (bodyOffset + length > file.length) return null;
    frames.push(new Uint8Array(file.buffer, file.byteOffset + bodyOffset, length));
    bodyOffset += length;
  }
  return bodyOffset === file.length ? frames : null;
}

function enforceSizeCap(directory, maxBytes, keptName) {
  const entries = readdirSync(directory)
    .filter(name => FILE_NAME.test(name))
    .map(name => ({ name, ...statSync(join(directory, name)) }))
    .sort((older, newer) => older.mtimeMs - newer.mtimeMs);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    if (entry.name === keptName) continue;
    unlinkSync(join(directory, entry.name));
    total -= entry.size;
  }
}

/** A store for setExplosionBakeStore that keeps bakes in `directory`. Every failure (read-only folder, full disk, corrupt file) means "no cache", never an error. */
export function createExplosionBakeCache(directory, { maxBytes = BAKE_CACHE_MAX_BYTES } = {}) {
  return {
    load(descriptor) {
      try {
        return decodeBake(readFileSync(join(directory, fileNameFor(descriptor))), descriptor.frames);
      } catch {
        return null;
      }
    },
    save(descriptor, frames) {
      try {
        mkdirSync(directory, { recursive: true });
        const path = join(directory, fileNameFor(descriptor));
        const temporaryPath = `${path}.${process.pid}.tmp`;
        writeFileSync(temporaryPath, encodeBake(frames));
        renameSync(temporaryPath, path);
        enforceSizeCap(directory, maxBytes, fileNameFor(descriptor));
      } catch {
        // The bake is already in memory; a missing cache only costs the next process a rebake.
      }
    },
  };
}
