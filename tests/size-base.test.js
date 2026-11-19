import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_METHOD, SIZE_METHOD } from '../scripts/size-base.mjs';

const SCRIPTS_FOLDER = fileURLToPath(new URL('../scripts/', import.meta.url));
const RELATIVE_IMPORT = /^import [^\n]*from '(\.[^']+\.m?js)';/gm;

// The entry file and every relative module it imports, so a file that decides a measured number cannot be left out of the cache key.
function loadedFiles(entryPath, found = new Set()) {
  if (found.has(entryPath)) return found;
  found.add(entryPath);
  for (const match of readFileSync(entryPath, 'utf8').matchAll(RELATIVE_IMPORT)) loadedFiles(resolve(dirname(entryPath), match[1]), found);
  return found;
}

for (const [name, method] of [['size', SIZE_METHOD], ['archive', ARCHIVE_METHOD]]) {
  test(`the ${name} cache key names every file the measuring script imports`, () => {
    const keyed = new Set(method.files.map(file => resolve(SCRIPTS_FOLDER, file)));
    const missing = [...loadedFiles(method.script)]
      .filter(file => !keyed.has(file))
      .map(file => relative(SCRIPTS_FOLDER, file).replaceAll('\\', '/'));
    assert.deepEqual(missing, [], `Add these to the files of the ${name} method in scripts/size-base.mjs, or a change to them reuses a stale base measurement`);
  });
}
