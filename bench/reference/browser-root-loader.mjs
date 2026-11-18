// A Node module loader that reads the reference scenes' browser paths ("/src/geometry.js") from the repository root.
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const REPOSITORY_ROOT = resolvePath(import.meta.dirname, '../..');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/src/') || specifier.startsWith('/bench/')) {
    return nextResolve(pathToFileURL(resolvePath(REPOSITORY_ROOT, `.${specifier}`)).href, context);
  }
  return nextResolve(specifier, context);
}
