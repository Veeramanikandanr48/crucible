// Removes the line comments inside GLSL template literals, so the published bundles do not carry explanations
// that only a person reading src/ needs. JavaScript comments are left to the minifier.
// Used as a plugin by config/vite.lib.config.js and scripts/measure-size.mjs, so the size budgets measure the same text.
import { readFile } from 'node:fs/promises';

const GLSL_MARKER = /#version 300 es|^uniform /m;
const SOURCE_FILE = /[\\/]src[\\/][^\\/]+\.js$/;

function countBackticks(line) {
  return (line.match(/(?<!\\)`/g) ?? []).length;
}

// Finds where the line comment of one line starts (-1 when it has none) and whether a block comment is still open at its end.
// A "//" inside a block comment is text: cutting it would remove the "*/" that closes the block.
function scanLine(line, startsInsideBlock) {
  let insideBlock = startsInsideBlock;
  for (let index = 0; index < line.length; index++) {
    const pair = line.slice(index, index + 2);
    if (insideBlock && pair === '*/') {
      insideBlock = false;
      index++;
    } else if (!insideBlock && pair === '/*') {
      insideBlock = true;
      index++;
    } else if (!insideBlock && pair === '//') {
      return { commentStart: index, insideBlock };
    }
  }
  return { commentStart: -1, insideBlock };
}

// Returns the line without its comment (null when only a comment was on it) and whether a block comment is open after it.
function stripLine(line, startsInsideBlock) {
  const { commentStart, insideBlock } = scanLine(line, startsInsideBlock);
  if (commentStart === -1 || line.includes('${') || line.includes('`')) return { text: line, insideBlock };
  const code = line.slice(0, commentStart);
  if (code.trim() === '') return { text: null, insideBlock };
  return { text: /\s$/.test(code) ? code.replace(/\s+$/, '') : line, insideBlock };
}

export function stripGlslComments(source) {
  if (!GLSL_MARKER.test(source)) return source;
  let insideTemplate = false;
  let insideBlock = false;
  const kept = [];
  for (const line of source.split(/\r?\n/)) {
    const startedInside = insideTemplate;
    if (countBackticks(line) % 2 === 1) insideTemplate = !insideTemplate;
    if (!startedInside) {
      kept.push(line);
      continue;
    }
    const stripped = stripLine(line, insideBlock);
    insideBlock = insideTemplate && stripped.insideBlock;
    if (stripped.text !== null) kept.push(stripped.text);
  }
  return kept.join('\n');
}

export function glslCommentStripperForVite() {
  return {
    name: 'strip-glsl-comments',
    enforce: 'pre',
    transform(code, id) {
      return SOURCE_FILE.test(id) ? { code: stripGlslComments(code), map: null } : null;
    },
  };
}

export function glslCommentStripperForEsbuild() {
  return {
    name: 'strip-glsl-comments',
    setup(build) {
      build.onLoad({ filter: SOURCE_FILE }, async ({ path }) => ({ contents: stripGlslComments(await readFile(path, 'utf8')), loader: 'js' }));
    },
  };
}
