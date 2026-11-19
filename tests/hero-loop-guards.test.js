import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

const originalGlobals = {};
const GLOBAL_NAMES = ['window', 'document', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];

// A fake page: frames run only when the test calls them, and the observer callback is called by hand.
function installFakePage() {
  const page = { frames: [], observers: [], listeners: [], hidden: false, cancelled: [] };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.document = {
    get hidden() { return page.hidden; },
    addEventListener: (kind, listener) => page.listeners.push({ kind, listener }),
    removeEventListener: (kind, listener) => { page.listeners = page.listeners.filter(entry => entry.listener !== listener); },
  };
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; page.observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.requestAnimationFrame = callback => page.frames.push(callback);
  globalThis.cancelAnimationFrame = () => page.cancelled.push(true);
  return page;
}

beforeEach(() => {
  for (const name of GLOBAL_NAMES) originalGlobals[name] = globalThis[name];
});

afterEach(() => {
  for (const name of GLOBAL_NAMES) {
    if (originalGlobals[name] === undefined) delete globalThis[name];
    else globalThis[name] = originalGlobals[name];
  }
});

const key = at => ({ at, eye: [0, 0, 0], target: [0, 0, 1], fov: 40 });

test('startLoop follows the newest visibility entry when several arrive in one callback', async () => {
  const page = installFakePage();
  const { startLoop } = await import('../src/hero-lab/stage.js');
  let draws = 0;
  startLoop({ dataset: {} }, () => { draws++; return true; });
  page.observers[0].callback([{ isIntersecting: false }, { isIntersecting: true }]);
  for (let round = 0; round < 3; round++) page.frames.splice(0).forEach(frame => frame(1000 + round * 16));
  assert.ok(draws >= 3, `the stage ended visible, so the loop keeps drawing (drew ${draws})`);
});

test('startLoop stop releases the observer, the listener and the pending frame', async () => {
  const page = installFakePage();
  const { startLoop } = await import('../src/hero-lab/stage.js');
  const loop = startLoop({ dataset: {} }, () => true);
  assert.equal(typeof loop.stop, 'function', 'startLoop returns stop()');
  loop.stop();
  assert.equal(page.observers[0].disconnected, true);
  assert.equal(page.listeners.length, 0);
  assert.equal(page.cancelled.length, 1);
  const framesBefore = page.frames.length;
  loop.wake();
  assert.equal(page.frames.length, framesBefore, 'wake after stop schedules no new frame');
});

test('play on demand ignores a press while the world is still loading', async () => {
  const { createPlayOnDemand } = await import('../src/hero-lab/loop/play-on-demand.js');
  const label = { textContent: '' };
  const playButton = { dataset: {}, querySelector: () => label, disabled: false, hidden: false };
  let starts = 0;
  let handoffs = 0;
  const releases = [];
  const press = createPlayOnDemand({
    playButton,
    beginLive: () => { starts++; return new Promise(resolve => { releases.push(resolve); }); },
    showError: () => {},
    onLive: () => { handoffs++; },
    wait: callback => callback(),
  });
  const first = press();
  const second = press();
  releases.forEach(release => release());
  await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.equal(handoffs, 1);
});

test('createCameraSpline refuses fewer than two keys and keys whose positions do not rise', async () => {
  const { createCameraSpline } = await import('../src/hero-lab/camera-spline.js');
  assert.throws(() => createCameraSpline([key(0)]), /at least 2 keys/);
  assert.throws(() => createCameraSpline([key(0), key(0), key(1)]), /rising values/);
  const sample = createCameraSpline([key(0), key(1)]);
  assert.ok(Number.isFinite(sample(0.5).fov));
});
