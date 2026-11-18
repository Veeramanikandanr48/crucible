import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

// The Blender-free unit tests of bench/cycles-parity are Python (unittest, numpy). They never start Blender.
const PARITY_FOLDER = resolve('bench/cycles-parity');
const PYTHON_TEST_FILES = [
  'test_cycles_switches.py',
  'test_edge_width.py',
  'test_compare_depth.py',
  'test_run_classroom_parity.py',
];
const PROBE_TIMEOUT_MILLISECONDS = 120_000;
const SUITE_TIMEOUT_MILLISECONDS = 120_000;

// Each candidate is a command prefix that ends right before the python arguments.
const PYTHON_CANDIDATES = [
  ['uv', 'run', '--no-project', '--with', 'numpy', 'python'],
  ['python3'],
  ['python'],
];

function runCommand(commandPrefix, pythonArguments, timeoutMilliseconds) {
  const [executable, ...prefixArguments] = commandPrefix;
  return spawnSync(executable, [...prefixArguments, ...pythonArguments], {
    cwd: PARITY_FOLDER,
    encoding: 'utf8',
    timeout: timeoutMilliseconds,
    windowsHide: true,
  });
}

function findPythonWithNumpy() {
  return PYTHON_CANDIDATES.find((commandPrefix) => {
    const probe = runCommand(commandPrefix, ['-c', 'import numpy'], PROBE_TIMEOUT_MILLISECONDS);
    return probe.status === 0;
  });
}

test('the Blender-free cycles-parity Python unit tests pass', (context) => {
  const pythonCommand = findPythonWithNumpy();
  if (!pythonCommand) {
    context.skip('no Python with numpy found: install uv or python with numpy to run the bench/cycles-parity tests');
    return;
  }
  const result = runCommand(pythonCommand, ['-m', 'unittest', '-v', ...PYTHON_TEST_FILES], SUITE_TIMEOUT_MILLISECONDS);
  const stderrTail = (result.stderr ?? '').split('\n').slice(-40).join('\n');
  assert.equal(result.status, 0, `python -m unittest failed (status ${result.status}, ${result.error ?? 'no spawn error'}):\n${stderrTail}`);
});
