import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameGovernor } from '../src/frame-governor.js';
import { createRuntime } from '../src/runtime.js';

function createHarness(options = {}) {
  let pending = null;
  let nextHandle = 1;
  const visibilityCallbacks = new Set();
  const visibility = { hidden: false, subscribe: callback => { visibilityCallbacks.add(callback); return () => visibilityCallbacks.delete(callback); } };
  let observerCallback = null;
  let observerStopped = false;
  const scheduler = {
    request(callback) { pending = { callback, handle: nextHandle }; nextHandle += 1; return pending.handle; },
    cancel(handle) { if (pending?.handle === handle) pending = null; },
  };
  const drawn = [];
  const state = { busy: true };
  const governor = createFrameGovernor({
    draw: (timestamp, resumed) => drawn.push({ timestamp, resumed }),
    isBusy: () => state.busy,
    scheduler,
    visibility,
    element: options.element ?? {},
    observe: (element, callback) => { observerCallback = callback; return () => { observerStopped = true; }; },
    ...options.governor,
  });
  return {
    governor, drawn, state, visibility,
    pending: () => pending !== null,
    frame(timestamp = 0) { const { callback } = pending; pending = null; callback(timestamp); },
    setHidden(hidden) { visibility.hidden = hidden; for (const callback of visibilityCallbacks) callback(); },
    setOnscreen(onscreen) { observerCallback(onscreen); },
    observerStopped: () => observerStopped,
  };
}

test('a busy loop keeps drawing and an idle loop schedules nothing', () => {
  const harness = createHarness();
  harness.governor.start();
  harness.frame();
  assert.equal(harness.pending(), true);
  harness.state.busy = false;
  harness.frame();
  assert.equal(harness.pending(), false);
  assert.equal(harness.governor.sleeping, true);
  assert.equal(harness.governor.draws, 2);
});

test('wake draws one frame after sleep, marked as resumed, and sleeps again when still idle', () => {
  const harness = createHarness();
  harness.state.busy = false;
  harness.governor.start();
  harness.frame();
  assert.equal(harness.pending(), false);
  harness.governor.wake();
  harness.governor.wake();
  harness.frame(16);
  assert.equal(harness.governor.draws, 2);
  assert.deepEqual(harness.drawn.map(entry => entry.resumed), [true, true]);
  assert.equal(harness.pending(), false);
});

test('a loop that stays busy is not marked as resumed after its first frame', () => {
  const harness = createHarness();
  harness.governor.start();
  harness.frame();
  harness.frame();
  assert.deepEqual(harness.drawn.map(entry => entry.resumed), [true, false]);
});

test('idleSleep false never sleeps', () => {
  const harness = createHarness({ governor: { idleSleep: false } });
  harness.state.busy = false;
  harness.governor.start();
  harness.frame();
  assert.equal(harness.pending(), true);
});

test('an offscreen canvas draws nothing and comes back with one frame when it scrolls into view', () => {
  const harness = createHarness();
  harness.governor.start();
  harness.frame();
  harness.setOnscreen(false);
  assert.equal(harness.pending(), false);
  assert.equal(harness.governor.paused, true);
  harness.governor.wake();
  assert.equal(harness.pending(), false);
  harness.setOnscreen(true);
  assert.equal(harness.pending(), true);
  harness.frame();
  assert.equal(harness.drawn.at(-1).resumed, true);
});

test('a hidden tab pauses and showing it resumes', () => {
  const harness = createHarness();
  harness.governor.start();
  harness.setHidden(true);
  assert.equal(harness.pending(), false);
  harness.setHidden(false);
  assert.equal(harness.pending(), true);
});

test('pauseWhenOffscreen false ignores the observer and pauseWhenHidden false ignores the tab', () => {
  const offscreen = createHarness({ governor: { pauseWhenOffscreen: false } });
  offscreen.governor.start();
  assert.equal(offscreen.pending(), true);
  const hidden = createHarness({ governor: { pauseWhenHidden: false } });
  hidden.governor.start();
  hidden.setHidden(true);
  assert.equal(hidden.pending(), true);
});

test('hold and release, stop and dispose', () => {
  const harness = createHarness();
  harness.governor.start();
  harness.governor.hold();
  assert.equal(harness.pending(), false);
  harness.governor.wake();
  assert.equal(harness.pending(), false);
  harness.governor.release();
  assert.equal(harness.pending(), true);
  harness.governor.dispose();
  assert.equal(harness.pending(), false);
  assert.equal(harness.observerStopped(), true);
});

test('options are validated with messages that say what to pass', () => {
  assert.throws(() => createFrameGovernor({}), /needs \{ draw/);
  assert.throws(() => createFrameGovernor({ draw() {}, isBusy: 1 }), /isBusy must be a function/);
  assert.throws(() => createFrameGovernor({ draw() {}, idleSleep: 'no' }), /idleSleep must be a boolean/);
});

test('a runtime with isIdle sleeps at zero draws and wake() brings the next frame', () => {
  let time = 0;
  let pending = null;
  let idle = false;
  const rendered = [];
  const runtime = createRuntime({ render: frame => rendered.push(frame) }, {
    scheduler: { request(callback) { pending = callback; return 1; }, cancel() { pending = null; } },
    clock: () => time,
    visibility: { hidden: false, subscribe: () => () => {} },
    isIdle: () => idle,
  });
  runtime.start();
  time += 16;
  pending();
  assert.notEqual(pending, null);
  idle = true;
  time += 16;
  const callback = pending;
  pending = null;
  callback();
  assert.equal(pending, null);
  assert.equal(runtime.sleeping, true);
  assert.equal(rendered.length, 2);
  idle = false;
  runtime.wake();
  assert.notEqual(pending, null);
  assert.equal(runtime.sleeping, false);
});

test('a runtime without isIdle never sleeps', () => {
  let pending = null;
  const runtime = createRuntime({ render() {} }, {
    scheduler: { request(callback) { pending = callback; return 1; }, cancel() { pending = null; } },
    visibility: { hidden: false, subscribe: () => () => {} },
  });
  runtime.start();
  const callback = pending;
  pending = null;
  callback();
  assert.notEqual(pending, null);
  assert.equal(runtime.sleeping, false);
});

test('a runtime pauses an offscreen element and rejects a bad isIdle', () => {
  let notify = null;
  let pending = null;
  const runtime = createRuntime({ render() {} }, {
    scheduler: { request(callback) { pending = callback; return 1; }, cancel() { pending = null; } },
    visibility: { hidden: false, subscribe: () => () => {} },
    element: {},
    observe: (element, callback) => { notify = callback; return () => {}; },
  });
  runtime.start();
  notify(false);
  assert.equal(pending, null);
  assert.equal(runtime.paused, true);
  notify(true);
  assert.notEqual(pending, null);
  assert.throws(() => createRuntime({ render() {} }, { scheduler: { request() {}, cancel() {} }, isIdle: true }), /isIdle must be a function/);
});
