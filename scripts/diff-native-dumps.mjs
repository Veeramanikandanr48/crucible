// Compares two directories written by scripts/dump-native-results.mjs (lavapipe miscompile sweep, #1760).
// Usage: node scripts/diff-native-dumps.mjs <default-dump-dir> <nopt-dump-dir> [relative-tolerance]
// Prints a Markdown table of every native call whose result differs. A result is "identical" when every SHA-1 matches;
// otherwise the largest relative difference of sum and mean is shown, and it counts as "material" above the tolerance
// (default 1e-4), which separates a changed kernel result from the last-bit rounding an optimisation pass may legitimately change.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_TOLERANCE = 1e-4;

function readDump(directory) {
  const calls = new Map();
  for (const fileName of readdirSync(directory).filter((name) => name.endsWith('.ndjson')).sort()) {
    for (const line of readFileSync(join(directory, fileName), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      const key = `${entry.process} #${entry.index} ${entry.call}`;
      const entries = calls.get(key) ?? [];
      entries.push(entry);
      calls.set(key, entries);
    }
  }
  return calls;
}

// Timing fields differ on every run and say nothing about the kernel's result.
// The dispatch budget splits a trace by measured speed, so tile sizes and dispatch counts follow timing too.
const TIMING_PATH = /seconds|millis|duration|elapsed|timing|dispatchCount|samplesPerDispatch|tilePixels|tileCount/i;

function collectLeaves(value, path, leaves) {
  if (TIMING_PATH.test(path)) return;
  if (value === null || typeof value !== 'object') {
    leaves.set(path, value);
    return;
  }
  for (const [key, child] of Object.entries(value)) collectLeaves(child, `${path}.${key}`, leaves);
}

function relativeDifference(left, right) {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale === 0 ? 0 : Math.abs(left - right) / scale;
}

export function compareEntries(defaultEntry, noptEntry, tolerance) {
  const defaultLeaves = new Map();
  const noptLeaves = new Map();
  collectLeaves({ result: defaultEntry.result, error: defaultEntry.error }, '', defaultLeaves);
  collectLeaves({ result: noptEntry.result, error: noptEntry.error }, '', noptLeaves);
  const differences = [];
  let maximumRelative = 0;
  for (const [path, defaultValue] of defaultLeaves) {
    const noptValue = noptLeaves.get(path);
    if (defaultValue === noptValue) continue;
    if (typeof defaultValue === 'number' && typeof noptValue === 'number') {
      const relative = relativeDifference(defaultValue, noptValue);
      if (!path.endsWith('.sha1')) maximumRelative = Math.max(maximumRelative, relative);
      differences.push({ path, defaultValue, noptValue, relative });
    } else {
      differences.push({ path, defaultValue, noptValue, relative: Infinity });
      if (!path.endsWith('.sha1')) maximumRelative = Infinity;
    }
  }
  const onlyHashesDiffer = differences.length > 0 && differences.every((item) => item.path.endsWith('.sha1'));
  return { differences, maximumRelative, material: maximumRelative > tolerance, onlyHashesDiffer };
}

function describeDifference(comparison) {
  const numeric = comparison.differences.filter((item) => !item.path.endsWith('.sha1')).slice(0, 3);
  if (numeric.length === 0) return 'bytes differ, sum and range equal';
  return numeric.map((item) => `${item.path}: ${item.defaultValue} vs ${item.noptValue}`).join('; ');
}

export function diffDumps(defaultDirectory, noptDirectory, tolerance = DEFAULT_TOLERANCE) {
  const defaultCalls = readDump(defaultDirectory);
  const noptCalls = readDump(noptDirectory);
  const keys = [...new Set([...defaultCalls.keys(), ...noptCalls.keys()])].sort();
  const rows = [];
  let identical = 0;
  for (const key of keys) {
    const defaultEntries = defaultCalls.get(key) ?? [];
    const noptEntries = noptCalls.get(key) ?? [];
    if (defaultEntries.length !== noptEntries.length) {
      rows.push({ key, kind: 'call count', detail: `${defaultEntries.length} default vs ${noptEntries.length} nopt`, material: true });
      continue;
    }
    // Calls with the same key from several processes (a test that spawns the same script twice) are paired in file order.
    for (let position = 0; position < defaultEntries.length; position += 1) {
      const comparison = compareEntries(defaultEntries[position], noptEntries[position], tolerance);
      if (comparison.differences.length === 0) {
        identical += 1;
        continue;
      }
      rows.push({
        key,
        kind: comparison.material ? 'MATERIAL' : 'rounding',
        detail: describeDifference(comparison),
        material: comparison.material,
        maximumRelative: comparison.maximumRelative,
      });
    }
  }
  return { rows, identical, total: keys.length, tolerance };
}

function formatReport(report) {
  const material = report.rows.filter((row) => row.material);
  const lines = [
    `Native calls compared: ${report.total}, identical: ${report.identical}, differing: ${report.rows.length}, material (relative difference above ${report.tolerance}): ${material.length}`,
    '',
    '| call | kind | max relative | detail |',
    '|---|---|---|---|',
  ];
  for (const row of report.rows) {
    const relative = row.maximumRelative === undefined ? '' : row.maximumRelative.toExponential(2);
    lines.push(`| ${row.key} | ${row.kind} | ${relative} | ${row.detail.replaceAll('|', '/')} |`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('diff-native-dumps.mjs')) {
  const [defaultDirectory, noptDirectory, toleranceText] = process.argv.slice(2);
  if (!defaultDirectory || !noptDirectory) {
    console.error('Usage: node scripts/diff-native-dumps.mjs <default-dump-dir> <nopt-dump-dir> [relative-tolerance]');
    process.exit(2);
  }
  const tolerance = toleranceText === undefined ? DEFAULT_TOLERANCE : Number(toleranceText);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    console.error(`The tolerance must be a non-negative number such as 1e-4, got ${JSON.stringify(toleranceText)}.`);
    process.exit(2);
  }
  console.log(formatReport(diffDumps(defaultDirectory, noptDirectory, tolerance)));
}
