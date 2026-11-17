import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, parseArguments, shapeReport } from '../scripts/measure-explosion-render-time.mjs';

// The argument and report shaping of scripts/measure-explosion-render-time.mjs (#1050); the render itself needs a GPU and runs by hand.

test('defaults are the 8 s, 1080p, 3 run measurement of the issue', () => {
  const options = parseArguments([]);
  assert.deepEqual(options, DEFAULT_OPTIONS);
  assert.equal(options.duration, 8);
  assert.equal(`${options.width}x${options.height}`, '1920x1080');
  assert.equal(options.runs, 3);
});

test('options are read as numbers, and max-seconds maps to maxSeconds', () => {
  const options = parseArguments(['--runs', '2', '--max-seconds', '90', '--backend', 'cpu', '--out', 'somewhere']);
  assert.equal(options.runs, 2);
  assert.equal(options.maxSeconds, 90);
  assert.equal(options.backend, 'cpu');
  assert.equal(options.out, 'somewhere');
});

test('bad options say what to pass instead', () => {
  assert.throws(() => parseArguments(['--speed', '3']), /Unknown or incomplete option --speed; use/);
  assert.throws(() => parseArguments(['--runs']), /incomplete option --runs/);
  assert.throws(() => parseArguments(['--runs', '0']), /--runs needs a positive number, got 0/);
  assert.throws(() => parseArguments(['--backend', 'tpu']), /--backend takes gpu or cpu, got tpu/);
});

test('the report keeps the phases the job names and the 30 s verdict', () => {
  const metrics = { renderSeconds: 0.4916, captureSeconds: 4.7183, elapsedSeconds: 7.2491, encoder: { backpressureSeconds: 0.2868, finishSeconds: 0.1674 } };
  const shaped = shapeReport({ options: DEFAULT_OPTIONS, runIndex: 0, buildSeconds: 8.891, submitSeconds: 0.02, jobSeconds: 7.42, totalSeconds: 16.331, metrics });
  assert.equal(shaped.run, 1);
  assert.equal(shaped.frames, 192);
  assert.equal(shaped.size, '1920x1080');
  assert.deepEqual(shaped.phases, { drawSeconds: 0.49, captureSeconds: 4.72, encoderBackpressureSeconds: 0.29, encoderFinishSeconds: 0.17 });
  assert.equal(shaped.jobReportSeconds, 7.25);
  assert.equal(shaped.totalSeconds, 16.33);
  assert.equal(shaped.meetsThirtySeconds, true);
  assert.equal(shapeReport({ options: DEFAULT_OPTIONS, runIndex: 1, buildSeconds: 20, submitSeconds: 0, jobSeconds: 12, totalSeconds: 32, metrics: {} }).meetsThirtySeconds, false);
});

test('a job report without phases leaves them out instead of inventing them', () => {
  const shaped = shapeReport({ options: DEFAULT_OPTIONS, runIndex: 0, buildSeconds: 1, submitSeconds: 0, jobSeconds: 2, totalSeconds: 3, metrics: undefined });
  assert.deepEqual(shaped.phases, {});
  assert.equal(shaped.jobReportSeconds, undefined);
});
