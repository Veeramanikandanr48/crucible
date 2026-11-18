import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { packRecipeFile } from '../src/scene-pack.js';
import { addGeneratedPoster, parsePosterSize, POSTER_DEFAULT_SIZE, POSTER_SIZE_LIMITS } from '../src/scene-pack-poster.js';
import { parsePackArguments } from '../bin/crucible.mjs';

const RECIPE_PATH = 'public/recipes/view-transform.json';
const SMOKE_SIZE = Object.freeze({ width: 640, height: 360 });

// Width and height from the first chunk of a WebP file (lossy VP8, lossless VP8L or extended VP8X).
function webpDimensions(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  const bits = bytes.readUInt32LE(21);
  return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
}

test('parsePosterSize reads <width>x<height> and keeps both sides inside the limits', () => {
  assert.deepEqual(parsePosterSize('1280x720'), POSTER_DEFAULT_SIZE);
  assert.deepEqual(parsePosterSize(`${POSTER_SIZE_LIMITS.minimum}x${POSTER_SIZE_LIMITS.maximum}`), { width: POSTER_SIZE_LIMITS.minimum, height: POSTER_SIZE_LIMITS.maximum });
  assert.throws(() => parsePosterSize('1280'), /--poster-size: got "1280"; pass <width>x<height>/);
  assert.throws(() => parsePosterSize('wide'), /pass <width>x<height>/);
  assert.throws(() => parsePosterSize('63x720'), /out of range; each side must be from 64 to 2560/);
  assert.throws(() => parsePosterSize('1280x2561'), /out of range/);
  assert.throws(() => parsePosterSize('0x0'), /out of range/);
});

test('crucible pack reads --poster-size and --no-poster, and refuses flags that contradict each other', () => {
  assert.equal(parsePackArguments(['a.json', '--out', 'dist']).noPoster, undefined);
  assert.equal(parsePackArguments(['a.json', '--out', 'dist', '--no-poster']).noPoster, true);
  assert.equal(parsePackArguments(['a.json', '--out', 'dist', '--poster-size', '800x450']).posterSize, '800x450');
  assert.throws(() => parsePackArguments(['a.json', '--poster', 'p.webp', '--no-poster']), /pass one/);
  assert.throws(() => parsePackArguments(['a.json', '--no-poster', '--poster-size', '800x450']), /--poster-size: .*drop it when you pass --poster or --no-poster/);
  assert.throws(() => parsePackArguments(['a.json', '--poster', 'p.webp', '--poster-size', '800x450']), /--poster-size/);
  assert.throws(() => parsePackArguments(['a.json', '--poster-size']), /--poster-size: pass a value/);
});

test('a packed scene gets a WebP poster of the requested size, and index.html uses it', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-poster-'));
  try {
    const runtimeFolder = join(folder, 'runtime');
    await build({ entryPoints: ['src/crucible-scene.js'], bundle: true, format: 'esm', splitting: true, outdir: runtimeFolder, logLevel: 'error' });
    const outDir = join(folder, 'out');
    await packRecipeFile({ recipePath: RECIPE_PATH, outDir, runtimePath: join(runtimeFolder, 'crucible-scene.js'), packageRoot: folder });
    assert.ok(!existsSync(join(outDir, 'poster.webp')), 'pack alone writes no poster');
    try {
      await addGeneratedPoster({ outDir, title: 'view-transform', size: SMOKE_SIZE });
    } catch (error) {
      if (/headless Chrome did not start/.test(error.message)) return t.skip('no Chrome to render the poster with');
      throw error;
    }
    const poster = readFileSync(join(outDir, 'poster.webp'));
    assert.deepEqual(webpDimensions(poster), SMOKE_SIZE);
    assert.ok(poster.length > 1500, `a drawn scene is more than a flat colour (got ${poster.length} bytes)`);
    assert.match(readFileSync(join(outDir, 'index.html'), 'utf8'), /<crucible-scene src="\.\/scene\.pack" poster="\.\/poster\.webp">/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
