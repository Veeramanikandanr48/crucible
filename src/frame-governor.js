// Resource governor for live web rendering (issue #2179). It owns one question: should the next frame be drawn at all?
// A frame is drawn only while something changes. When the loop reports it is idle the governor stops asking the browser for
// frames, so the page costs no GPU and no CPU, and it starts again on wake(). It also pauses while the tab is hidden and
// while the canvas is scrolled out of view. The scheduler, visibility and observer are injected, so tests run it without a browser.

function defaultScheduler() {
  if (typeof requestAnimationFrame !== 'function' || typeof cancelAnimationFrame !== 'function') {
    throw new TypeError('createFrameGovernor found no requestAnimationFrame. Pass options.scheduler as { request(callback), cancel(handle) }.');
  }
  return { request: callback => requestAnimationFrame(callback), cancel: handle => cancelAnimationFrame(handle) };
}

function defaultVisibility() {
  if (typeof document === 'undefined') return { hidden: false, subscribe: () => () => {} };
  return {
    get hidden() { return document.hidden; },
    subscribe(callback) {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
  };
}

/** Calls `callback(onscreen)` whenever the element enters or leaves the viewport. Returns a function that stops watching. */
function defaultObserve(element, callback) {
  if (typeof IntersectionObserver !== 'function') return () => {};
  const observer = new IntersectionObserver(entries => {
    const latest = entries[entries.length - 1];
    if (latest) callback(latest.isIntersecting);
  });
  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * Decides when a live loop draws.
 * - `draw(timestamp, resumed)` renders one frame; `resumed` is true when the frame follows a sleep, a pause or the start.
 * - `isBusy()` says whether another frame is needed (animation playing, temporal accumulation still converging, input easing).
 *   Return false once the picture has settled and the governor sleeps until `wake()`.
 * - `idleSleep: false` keeps drawing every frame, the old behaviour. Hidden tabs and offscreen canvases still pause.
 * - `element` is watched with an IntersectionObserver; `pauseWhenOffscreen: false` skips that. `pauseWhenHidden: false` skips the tab check.
 */
export function createFrameGovernor(options) {
  if (options === null || typeof options !== 'object' || typeof options.draw !== 'function') {
    throw new TypeError('createFrameGovernor needs { draw(timestamp, resumed) }, such as createFrameGovernor({ draw, isBusy }).');
  }
  if (options.isBusy !== undefined && typeof options.isBusy !== 'function') {
    throw new TypeError('createFrameGovernor isBusy must be a function () => boolean, or left out.');
  }
  for (const name of ['idleSleep', 'pauseWhenHidden', 'pauseWhenOffscreen']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new TypeError(`createFrameGovernor ${name} must be a boolean, got ${String(options[name])}.`);
  }
  const { draw } = options;
  const isBusy = options.isBusy ?? (() => false);
  const idleSleep = options.idleSleep ?? true;
  const pauseWhenHidden = options.pauseWhenHidden ?? true;
  const pauseWhenOffscreen = options.pauseWhenOffscreen ?? true;
  const scheduler = options.scheduler ?? defaultScheduler();
  const visibility = options.visibility ?? defaultVisibility();
  const observe = options.observe ?? defaultObserve;

  let started = false;
  let held = false;
  let onscreen = true;
  let handle = null;
  let continuous = false;
  let draws = 0;
  let unsubscribeVisibility = null;
  let unobserve = null;

  const isPaused = () => held || (pauseWhenHidden && visibility.hidden === true) || (pauseWhenOffscreen && !onscreen);

  function cancelFrame() {
    if (handle === null) return;
    scheduler.cancel(handle);
    handle = null;
  }

  function tick(timestamp) {
    handle = null;
    if (!started || isPaused()) return;
    const resumed = !continuous;
    continuous = false;
    draw(timestamp, resumed);
    draws += 1;
    if (!started || isPaused()) return;
    if (!idleSleep || isBusy()) {
      continuous = true;
      schedule();
    }
  }

  function schedule() {
    if (started && handle === null && !isPaused()) handle = scheduler.request(tick);
  }

  function onStateChange() {
    if (isPaused()) {
      cancelFrame();
      continuous = false;
      return;
    }
    schedule();
  }

  const governor = {
    /** Starts the loop and draws the first frame. Starting a started governor does nothing. */
    start() {
      if (started) return governor;
      started = true;
      continuous = false;
      unsubscribeVisibility ??= visibility.subscribe(onStateChange);
      if (pauseWhenOffscreen && options.element && unobserve === null) {
        unobserve = observe(options.element, isOnscreen => {
          onscreen = isOnscreen;
          onStateChange();
        });
      }
      schedule();
      return governor;
    },

    /** Asks for one more frame after something changed: input, state, a resize. Does nothing while paused or already scheduled. */
    wake() {
      schedule();
      return governor;
    },

    /** Holds the loop without ending it, for a manual pause. */
    hold() {
      held = true;
      cancelFrame();
      continuous = false;
      return governor;
    },

    release() {
      held = false;
      schedule();
      return governor;
    },

    stop() {
      started = false;
      cancelFrame();
      continuous = false;
      return governor;
    },

    dispose() {
      governor.stop();
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
      unobserve?.();
      unobserve = null;
    },

    get running() { return started; },
    get paused() { return started && isPaused(); },
    /** True while started, unpaused and waiting for wake(): the state that costs nothing. */
    get sleeping() { return started && !isPaused() && handle === null; },
    get draws() { return draws; },
  };
  return governor;
}
