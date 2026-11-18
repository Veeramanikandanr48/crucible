import { createContext, Script } from 'node:vm';

// A small stand-in for the browser, just enough to run the script of an exported review page (issue #924) in Node: elements by id,
// pointer events with positions, and the saved file text. The real page is checked in headless Chrome at phone size (see the pull request).

class FakeElement {
  constructor(tagName = 'div', box = { left: 0, top: 0, width: 0, height: 0 }) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.box = box;
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.attributes = new Map();
    this.textContent = '';
  }

  set textContent(text) {
    this.text = String(text);
    if (text === '') this.children = [];
  }

  get textContent() {
    return this.text;
  }

  get lastChild() {
    return this.children.at(-1);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event });
  }

  append(...elements) {
    this.children.push(...elements);
  }

  appendChild(element) {
    this.children.push(element);
    return element;
  }

  querySelectorAll(selector) {
    const className = selector.slice(1);
    return this.children.filter(child => child.className === className).map(child => Object.assign(child, { remove: () => { this.children = this.children.filter(other => other !== child); } }));
  }

  querySelector(selector) {
    return this.children.find(child => child.tagName === selector.toUpperCase());
  }

  getBoundingClientRect() {
    return this.box;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  focus() {}

  remove() {}

  click() {}
}

/**
 * Runs the script of the review page `html` and returns a handle: tap(clientX, clientY), write(pinNumber, note), saveFileText()
 * (what the Save file button would write), and the elements. The stage is shown at its natural pixel size.
 */
export function openReviewPage(html) {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)];
  const config = scripts.find(([, type]) => type.includes('application/json'))[2];
  const code = scripts.find(([, type]) => type.trim() === '')[2];
  const { width, height } = JSON.parse(config);
  const box = { left: 0, top: 0, width, height };
  const elements = Object.fromEntries(['review-config', 'viewport', 'stage', 'frame', 'rows', 'count', 'download', 'copy', 'saved']
    .map(id => [id, new FakeElement(id === 'download' || id === 'copy' ? 'button' : 'div', box)]));
  elements['review-config'].textContent = config;
  elements.saved.hidden = true;
  const savedFiles = [];
  const document = {
    getElementById: id => elements[id],
    createElement: tag => {
      const element = new FakeElement(tag);
      if (tag === 'a') element.click = () => savedFiles.push(element.download);
      return element;
    },
    body: new FakeElement('body'),
  };
  const context = createContext({ document, window: {}, navigator: {}, URL: { createObjectURL: () => 'blob:fake' }, Blob: class { constructor(parts) { this.parts = parts; } }, Math, JSON, String, Map });
  new Script(code).runInContext(context);
  const viewport = elements.viewport;
  let nextPointerId = 1;
  return {
    elements,
    savedFiles,
    tap(clientX, clientY) {
      const pointerId = nextPointerId++;
      viewport.dispatch('pointerdown', { pointerId, clientX, clientY });
      viewport.dispatch('pointerup', { pointerId, clientX, clientY });
    },
    twoFingerTap(clientX, clientY) {
      const first = nextPointerId++;
      const second = nextPointerId++;
      viewport.dispatch('pointerdown', { pointerId: first, clientX, clientY });
      viewport.dispatch('pointerdown', { pointerId: second, clientX: clientX + 40, clientY });
      viewport.dispatch('pointerup', { pointerId: second, clientX: clientX + 40, clientY });
      viewport.dispatch('pointerup', { pointerId: first, clientX, clientY });
    },
    write(pinNumber, note) {
      const input = elements.rows.children[pinNumber - 1].children[1];
      input.value = note;
      input.dispatch('input');
    },
    saveFileText: () => context.window.crucibleReview.fileText(),
  };
}
