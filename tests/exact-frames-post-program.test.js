import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { WebGL2GlazeBackend } from '../src/glaze-backend-webgl2.js';

// A frame drawn while the driver still builds its post program uses the program with every step, whose maths differs from the
// specialised program by a half-float step on some pixels, so a cold first frame differed from a warm one (#1767). A renderer
// made with exactFrames waits for the program instead. A stub context stands in for the driver: its programs never finish
// building until `finishBuilding` is called, and link status is read only once they have.

function createStubRenderer({ exactFrames }) {
  const completion = { finished: false };
  const completionStatus = 0x91b1;
  const linkStatus = 0x8b82;
  const readsOfLinkStatus = [];
  const context = {
    LINK_STATUS: linkStatus,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    createProgram: () => ({ name: 'variant' }),
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    attachShader() {},
    linkProgram() {},
    deleteShader() {},
    getUniformLocation: () => ({}),
    getExtension: name => (name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: completionStatus } : null),
    getProgramParameter(program, parameter) {
      if (parameter === completionStatus) return completion.finished;
      readsOfLinkStatus.push(parameter);
      return true;
    },
  };
  const renderer = Object.create(CrucibleRenderer.prototype);
  Object.assign(renderer, {
    context,
    backend: new WebGL2GlazeBackend(context),
    exactFrames,
    postProgram: { name: 'fallback' },
    postUniforms: { name: 'fallback uniforms' },
    postVariants: new Map(),
    withViewTransform: source => source,
  });
  return { renderer, readsOfLinkStatus };
}

test('a frame draws with the all-steps fallback while its post program builds, unless the renderer asks for exact frames', () => {
  const { renderer } = createStubRenderer({ exactFrames: false });
  const selected = renderer.selectPostProgram(['bloom', 'finish']);
  assert.equal(selected.program.name, 'fallback');
});

test('a renderer with exact frames waits for its post program and draws with it', () => {
  const { renderer, readsOfLinkStatus } = createStubRenderer({ exactFrames: true });
  const selected = renderer.selectPostProgram(['bloom', 'finish']);
  assert.equal(selected.program.name, 'variant');
  assert.equal(readsOfLinkStatus.length > 0, true, 'the link status was read, which waits for the build');
});

test('the preview page makes every renderer exact', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../scripts/agent-preview-browser.js', import.meta.url), 'utf8');
  assert.match(page, /exactFrames: true/);
});
