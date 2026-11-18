// Keeps Chrome's GPU shader cache between preview browsers (#1768). The preview browser is started fresh for every server process, so
// without this the first scene with a heavy shader (a volume composite) pays its whole driver compile again, 5 s warm and 15 s cold.
//
// Chrome has no switch that moves only this cache (`--disk-cache-dir` moves the HTTP cache and leaves GPUCache in the profile), and
// two Chrome processes cannot share one profile folder. So each server process runs Chrome on its own temporary profile, copies the
// shared cache folder in before the start, and copies the profile's GPUCache back after Chrome has closed. Only that one folder
// travels; cookies, history, storage and the rest of the profile are never copied. The copy back is a rename, never a write in place,
// and a cache that another process is writing or reading is skipped, never waited for.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEnvironmentVariable } from '../src/environment-variable.js';

export const SHADER_CACHE_VARIABLE = 'SHADER_CACHE';
export const SHADER_CACHE_MAX_BYTES = 256 * 1024 * 1024;
// The one folder of a Chrome profile that holds the compiled shader programs. ShaderCache, GrShaderCache and the Dawn caches were
// measured: seeding them gave no speed-up, so they are not kept.
export const SHADER_CACHE_PROFILE_FOLDER = join('Default', 'GPUCache');
const WRITE_LOCK_NAME = '.write-lock';
const WRITE_LOCK_STALE_MILLISECONDS = 30_000;

/**
 * The shared cache folder: CRUCIBLE_SHADER_CACHE (an absolute folder, or "0" or "off"), else `crucible/shader-cache` in the user's
 * cache folder (XDG_CACHE_HOME, else LOCALAPPDATA on Windows, else ~/.cache). Null when off.
 */
export function shaderCacheDirectory(env = process.env, platform = process.platform) {
  const configured = readEnvironmentVariable(SHADER_CACHE_VARIABLE, env);
  if (configured === 'off' || configured === '0') return null;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error(`CRUCIBLE_SHADER_CACHE must be an absolute folder, "0" or "off", got "${configured}".`);
    return configured;
  }
  const base = env.XDG_CACHE_HOME || (platform === 'win32' && env.LOCALAPPDATA ? env.LOCALAPPDATA : join(homedir(), '.cache'));
  return join(base, 'crucible', 'shader-cache');
}

/** Bytes of every file under a folder; 0 when it does not exist. */
export function folderBytes(folder) {
  if (!existsSync(folder)) return 0;
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    total += entry.isDirectory() ? folderBytes(path) : statSync(path).size;
  }
  return total;
}

function writeLockPath(cacheFolder) {
  return join(cacheFolder, WRITE_LOCK_NAME);
}

/** True while another process is replacing the cache, so a reader leaves it alone. A lock older than the stale limit is a dead writer's and does not count. */
export function isWriteLocked(cacheFolder, now = Date.now()) {
  try {
    return now - statSync(writeLockPath(cacheFolder)).mtimeMs < WRITE_LOCK_STALE_MILLISECONDS;
  } catch {
    return false;
  }
}

function takeWriteLock(cacheFolder) {
  if (isWriteLocked(cacheFolder)) return false;
  const lockPath = writeLockPath(cacheFolder);
  try {
    // A stale lock is cleared first; mkdir then fails for exactly one of two processes that race for it.
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the shared cache into a new profile before Chrome starts. Returns 'seeded', or the reason nothing was copied: 'empty',
 * 'locked' (another process is replacing it), 'too-large' (over the cap, so it is dropped) or 'failed'. Never throws: a cache that
 * cannot be read only means one slow first compile.
 */
export function seedShaderCache(cacheFolder, profileFolder, maximumBytes = SHADER_CACHE_MAX_BYTES) {
  const shared = join(cacheFolder, SHADER_CACHE_PROFILE_FOLDER);
  if (!existsSync(shared)) return 'empty';
  if (isWriteLocked(cacheFolder)) return 'locked';
  if (folderBytes(shared) > maximumBytes) {
    rmSync(shared, { recursive: true, force: true });
    return 'too-large';
  }
  const target = join(profileFolder, SHADER_CACHE_PROFILE_FOLDER);
  try {
    mkdirSync(join(profileFolder, 'Default'), { recursive: true });
    cpSync(shared, target, { recursive: true });
    return 'seeded';
  } catch {
    rmSync(target, { recursive: true, force: true });
    return 'failed';
  }
}

/**
 * Copies the profile's GPUCache back to the shared folder after Chrome has closed: into a new folder beside it, then renames it into
 * place, so a reader sees the old cache or the new one, never half of one. Returns 'saved', or 'nothing' (Chrome wrote no cache),
 * 'too-large' (over the cap, so the shared copy is dropped and the next process starts empty), 'locked' (another process is saving) or
 * 'failed'. Never throws.
 */
export function saveShaderCache(cacheFolder, profileFolder, maximumBytes = SHADER_CACHE_MAX_BYTES) {
  const source = join(profileFolder, SHADER_CACHE_PROFILE_FOLDER);
  if (!existsSync(source)) return 'nothing';
  const shared = join(cacheFolder, SHADER_CACHE_PROFILE_FOLDER);
  if (folderBytes(source) > maximumBytes) {
    rmSync(shared, { recursive: true, force: true });
    return 'too-large';
  }
  const incoming = join(cacheFolder, `.incoming-${randomUUID()}`);
  let lockTaken = false;
  try {
    mkdirSync(cacheFolder, { recursive: true });
    cpSync(source, incoming, { recursive: true });
    lockTaken = takeWriteLock(cacheFolder);
    if (!lockTaken) return 'locked';
    const replaced = join(cacheFolder, `.replaced-${randomUUID()}`);
    mkdirSync(join(cacheFolder, 'Default'), { recursive: true });
    if (existsSync(shared)) renameSync(shared, replaced);
    renameSync(incoming, shared);
    rmSync(replaced, { recursive: true, force: true });
    return 'saved';
  } catch {
    return 'failed';
  } finally {
    rmSync(incoming, { recursive: true, force: true });
    if (lockTaken) rmSync(writeLockPath(cacheFolder), { recursive: true, force: true });
  }
}

/**
 * Starts Chrome on its own temporary profile, seeded from the shared shader cache, and returns the part of a Playwright Browser the
 * runtime uses (`newPage`, `isConnected`, `close`). `close` shuts Chrome, saves the cache and deletes the temporary profile.
 */
export async function launchWithShaderCache(chromium, launchOptions, cacheFolder, pageOptions = {}) {
  const profileFolder = mkdtempSync(join(tmpdir(), 'crucible-chrome-'));
  seedShaderCache(cacheFolder, profileFolder);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileFolder, { ...launchOptions, ...pageOptions });
  } catch (error) {
    rmSync(profileFolder, { recursive: true, force: true });
    throw error;
  }
  let connected = true;
  context.on('close', () => { connected = false; });
  return {
    isConnected: () => connected,
    async newPage({ viewport } = {}) {
      const page = await context.newPage();
      if (viewport) await page.setViewportSize(viewport);
      return page;
    },
    async close() {
      try {
        await context.close();
      } finally {
        saveShaderCache(cacheFolder, profileFolder);
        rmSync(profileFolder, { recursive: true, force: true });
      }
    },
  };
}
