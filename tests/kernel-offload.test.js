import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { buildWithKernels, kernelKey, runKernel } from '../src/kernel-offload.js';
import { answerKernelRequest } from '../src/kernel-registry.js';
import { createInProcessWorker, kernelRoom, sceneDigest } from './support/kernel-offload-fixture.mjs';
import { oversizedRoom } from './support/agent-bake-rooms.mjs';
import './support/load-agent-scene-modules.mjs';

const BUILD_SCRIPT = new URL('./support/kernel-offload-build.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOADER = new URL('./support/load-agent-scene-modules.mjs', import.meta.url).href;

// Each build runs in its own process so that nothing an earlier build cached (mesh evaluation, pattern textures) can
// stand in for the kernel under test.
function coldBuild(mode) {
  const output = execFileSync(process.execPath, ['--import', LOADER, BUILD_SCRIPT, mode], { encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').at(-1));
}

const inlineBuild = coldBuild('inline');

test('the same recipe builds to the same bytes on one thread and with kernels on a worker', () => {
  const workerBuild = coldBuild('worker');
  assert.equal(workerBuild.digest, inlineBuild.digest);
  for (const kernel of ['uvUnwrap', 'lightBake', 'cloth', 'pattern']) {
    assert.ok(workerBuild.requestedKernels.includes(kernel), `the ${kernel} kernel ran on the worker`);
  }
  assert.deepEqual(inlineBuild.requestedKernels, []);
});

test('a host without workers builds inline', async () => {
  const requested = [];
  const scene = await buildWithKernels(() => createAgentScene(kernelRoom()), {
    createWorker: () => { requested.push('started'); return {}; },
    available: false,
  });
  assert.deepEqual(requested, []);
  assert.equal(sceneDigest(scene), inlineBuild.digest);
});

test('a worker that cannot start leaves the work to the inline path with the same result', async () => {
  const scene = await buildWithKernels(() => createAgentScene(kernelRoom()), {
    createWorker: () => { throw new Error('no workers here'); },
    available: true,
  });
  assert.equal(sceneDigest(scene), inlineBuild.digest);
});

test('a worker that dies mid-job leaves the work to the inline path with the same result', async () => {
  const dying = {
    postMessage() {
      setTimeout(() => dying.onerror?.({ message: 'crashed' }), 0);
    },
    terminate() {},
  };
  const scene = await buildWithKernels(() => createAgentScene(kernelRoom()), { createWorker: () => dying, available: true });
  assert.equal(sceneDigest(scene), inlineBuild.digest);
});

test('an error a kernel raises on the worker comes back as the same class and message', async () => {
  const raised = answerKernelRequest({ name: 'pattern', args: [{ type: 'nope' }] });
  assert.equal(raised.response.error.name, 'RangeError');
  assert.match(raised.response.error.message, /type must be one of/);
  const raising = {
    postMessage() {
      setTimeout(() => raising.onmessage?.({ data: { error: { name: 'RangeError', message: 'Light bake passed maxSeconds (20).' } } }), 0);
    },
    terminate() {},
  };
  await assert.rejects(
    buildWithKernels(() => runKernel('lightBake', [[], {}, {}], () => 'inline'), { createWorker: () => raising, available: true }),
    error => error instanceof RangeError && error.message === 'Light bake passed maxSeconds (20).',
  );
});

test('a scene too large for even the lowest explicit settings fails on the worker with the same message as inline', async () => {
  const heavyRoom = () => oversizedRoom({ samples: 256, bounces: 3, texelsPerUnit: 12 });
  let inlineMessage = '';
  assert.throws(() => createAgentScene(heavyRoom()), error => {
    inlineMessage = error.message;
    return error instanceof RangeError;
  });
  assert.match(inlineMessage, /^Even samples 16, bounces 1 and texelsPerUnit 1 is [0-9]+ texels/);
  const requestedKernels = [];
  await assert.rejects(
    buildWithKernels(() => createAgentScene(heavyRoom()), { createWorker: () => createInProcessWorker(requestedKernels), available: true }),
    error => error instanceof RangeError && error.message === inlineMessage,
  );
  assert.ok(requestedKernels.includes('lightBake'), 'the budget check ran inside the worker kernel');
});

test('cancelling stops the build and ends the worker', async () => {
  const silent = { terminated: false, postMessage() {}, terminate() { silent.terminated = true; } };
  const controller = new AbortController();
  const pending = buildWithKernels(() => runKernel('pattern', [{ size: 1 }], () => 'inline'), {
    createWorker: () => silent,
    available: true,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(silent.terminated, true);
});

test('kernel keys follow the bytes of the input and refuse data that cannot be cloned', () => {
  const positions = new Float32Array([1, 2, 3]);
  assert.equal(kernelKey('cloth', [positions, { a: 1 }]), kernelKey('cloth', [new Float32Array([1, 2, 3]), { a: 1 }]));
  assert.notEqual(kernelKey('cloth', [positions]), kernelKey('cloth', [new Float32Array([1, 2, 4])]));
  assert.notEqual(kernelKey('cloth', [positions]), kernelKey('pattern', [positions]));
  assert.equal(kernelKey('cloth', [() => 1]), null);
  assert.equal(kernelKey('cloth', [new Map()]), null);
});

test('without a session a kernel computes inline', () => {
  assert.equal(runKernel('pattern', [2, 3], (left, right) => left + right), 5);
});

test('kernel keys differ for inputs whose text only looks alike', () => {
  assert.notEqual(kernelKey('cloth', [{ 'a=string:1': 1 }]), kernelKey('cloth', [{ a: '1=number:1' }]));
  assert.notEqual(kernelKey('cloth', [{ a: '1;b=string:2', c: 3 }]), kernelKey('cloth', [{ a: '1', b: '2' }]));
});

test('a self-referencing kernel input has no key and the build computes it inline', async () => {
  const loop = {};
  loop.self = loop;
  assert.equal(kernelKey('cloth', [loop]), null);
  const build = buildWithKernels(() => runKernel('cloth', [loop], () => 'inline'), { createWorker: () => createInProcessWorker(), available: true });
  assert.equal(await build, 'inline');
});

test('a worker answer the page cannot read leaves the work to the inline path instead of hanging', async () => {
  const unreadable = {
    postMessage() {
      setTimeout(() => unreadable.onmessageerror?.({}), 0);
    },
    terminate() {},
  };
  const build = buildWithKernels(() => runKernel('pattern', [{ size: 1 }], () => 'inline'), { createWorker: () => unreadable, available: true });
  const timeout = new Promise(resolve => setTimeout(() => resolve('hung'), 1000));
  assert.equal(await Promise.race([build, timeout]), 'inline');
});

test('a worker that never answers is ended after the timeout and the work runs inline instead of hanging', async () => {
  let terminated = 0;
  const silent = { postMessage() {}, terminate() { terminated++; } };
  const build = buildWithKernels(() => runKernel('pattern', [{ size: 1 }], () => 'inline'), {
    createWorker: () => silent,
    available: true,
    kernelTimeoutMilliseconds: 50,
  });
  const hung = new Promise(resolve => setTimeout(() => resolve('hung'), 1500));
  assert.equal(await Promise.race([build, hung]), 'inline');
  assert.ok(terminated >= 1, 'the silent worker was terminated');
});

test('a worker that stays silent is only waited for once per build', async () => {
  const silent = { postMessage() {}, terminate() {} };
  const started = Date.now();
  const build = buildWithKernels(
    () => [runKernel('pattern', [{ size: 1 }], () => 'a'), runKernel('pattern', [{ size: 2 }], () => 'b')],
    { createWorker: () => silent, available: true, kernelTimeoutMilliseconds: 300 },
  );
  const hung = new Promise(resolve => setTimeout(() => resolve('hung'), 1500));
  assert.deepEqual(await Promise.race([build, hung]), ['a', 'b']);
  assert.ok(Date.now() - started < 550, 'the second kernel did not wait for a second timeout');
});

test('the kernel timeout must be a finite number above 0 and bounded', async () => {
  for (const bad of [0, -1, Infinity, NaN, 1e12, '5']) {
    await assert.rejects(buildWithKernels(() => 1, { kernelTimeoutMilliseconds: bad }), /kernelTimeoutMilliseconds/);
  }
});
