import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { normalizeReview, reviewDeadlineMessage } from '../scripts/agent-review.mjs';
import { pathTraceTriangleProblem } from '../scripts/agent-render-estimate.mjs';
import { staleRevisionMessage } from '../src/agent-errors.js';

// The calls of an Opus benchmark build (issue 1325) that failed with a message that did not say what to change: each test sends the bad call.

async function connect(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test', jobs: { enabled: true } }; },
    async jobStatus({ jobId }) { return { jobId, state: 'running', progress: { frames: 1 } }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'agent-errors-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const reviewBase = { sessionId: 's', expectedRevision: 0 };

function reviewCameraError(camera) {
  try {
    normalizeReview({ ...reviewBase, shots: [{ camera }] });
  } catch (error) {
    return error;
  }
  return assert.fail('the review camera was accepted');
}

test('a review camera with focalLength, sensorWidth and up names the lens fields and the accepted set', () => {
  const error = reviewCameraError({ eye: [0, 1, 5], target: [0, 1, 0], up: [0, 1, 0], focalLength: 35, sensorWidth: 36 });
  assert.ok(error instanceof TypeError);
  assert.match(error.message, /camera fields not accepted: focalLength \(pass fov in degrees[^)]*\); sensorWidth \(pass fov in degrees/);
  assert.match(error.message, /Review camera takes eye, target, up, fov, near, far/);
  assert.doesNotMatch(error.message, /Invalid or unknown/);
});

test('a review shot or review with an unknown field names it and what it takes', () => {
  assert.throws(() => normalizeReview({ ...reviewBase, shots: [{ cam: {} }] }), /Review shot field not accepted: cam\. Review shot takes label, camera, animation/);
  assert.throws(() => normalizeReview({ ...reviewBase, shots: [{}], quality: 'high' }), /Review field not accepted: quality\. Review takes sessionId, expectedRevision/);
  assert.throws(() => normalizeReview({ ...reviewBase, shots: [{ camera: 'top' }] }), /Review camera must be an object with the fields eye, target, up, fov, near, far/);
});

test('a stale revision names both revisions and the current one to pass', () => {
  const message = staleRevisionMessage('render snapshot', 3, 5);
  assert.match(message, /^Stale revision for render snapshot: expectedRevision 3 is not the current revision 5\./);
  assert.match(message, /Pass expectedRevision 5/);
});

test('the preview page reports a stale snapshot and a stale branch with the current revision', () => {
  const page = readFileSync(new URL('../scripts/agent-preview-browser.js', import.meta.url), 'utf8');
  assert.match(page, /staleRevisionMessage\('render snapshot', expectedRevision, record\.scene\.revision\)/);
  assert.match(page, /staleRevisionMessage\('branch', expectedRevision, record\.scene\.revision\)/);
});

test('scene_render_status given a sessionId says jobs are addressed by jobId alone', async context => {
  const client = await connect(context);
  const result = await client.callTool({ name: 'scene_render_status', arguments: { jobId: randomUUID(), sessionId: randomUUID() } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /scene_render_status takes jobId \(and response_format\) only: remove sessionId\. A render job is addressed by its jobId/);
  const accepted = await client.callTool({ name: 'scene_render_status', arguments: { jobId: randomUUID() } });
  assert.notEqual(accepted.isError, true);
});

test('the other job tools give the same hint for sessionId', async context => {
  const client = await connect(context);
  const accepted = { scene_render_cancel: 'jobId', scene_render_result: 'jobId (and response_format, images)', scene_render_release: 'jobId' };
  for (const [name, keys] of Object.entries(accepted)) {
    const result = await client.callTool({ name, arguments: { jobId: randomUUID(), sessionId: randomUUID() } });
    assert.equal(result.isError, true, name);
    assert.ok(result.content[0].text.includes(`${name} takes ${keys} only: remove sessionId.`), `${name}: ${result.content[0].text}`);
  }
});

test('a path traced job over the cpu triangle cap is refused at submit with the count', () => {
  const problem = pathTraceTriangleProblem({ triangles: 820000 }, { type: 'pathTracer' });
  assert.match(problem, /^settings\.renderer: this scene has about 820000 triangles and the cpu path tracer takes at most 400000 in total\./);
  assert.match(problem, /renderer\.backend to "gpu" or "native"/);
  assert.match(pathTraceTriangleProblem({ triangles: 820000 }, { type: 'pathTracer', backend: 'cpu' }), /about 820000 triangles/);
});

test('the advice names only ways that work for the caller', () => {
  const cpuRuntime = pathTraceTriangleProblem({ triangles: 820000 }, { type: 'pathTracer' }, { canChooseBackend: false });
  assert.match(cpuRuntime, /Simplify or drop meshes; this runtime has no GPU backend\./);
  assert.doesNotMatch(cpuRuntime, /renderer\.backend/);
  const budgeted = pathTraceTriangleProblem({ triangles: 820000 }, { type: 'pathTracer' }, { picksRenderer: true });
  assert.match(budgeted, /leave budget and quality out and pick the renderer yourself/);
  assert.doesNotMatch(budgeted, /renderer\.backend/);
});

test('a borderline estimate between the cap and the safety margin is left to the exact check at trace time', () => {
  assert.equal(pathTraceTriangleProblem({ triangles: 575000 }, { type: 'pathTracer' }), undefined);
  assert.equal(pathTraceTriangleProblem({ triangles: 800000 }, { type: 'pathTracer' }), undefined);
});

test('an exact listed count over the cap is refused inside the safety margin, without "about"', () => {
  const problem = pathTraceTriangleProblem({ triangles: 682752, listedTriangles: 455168 }, { type: 'pathTracer' });
  assert.match(problem, /this scene has 455168 triangles and the cpu/);
  assert.equal(pathTraceTriangleProblem({ triangles: 682752, listedTriangles: 300000 }, { type: 'pathTracer' }), undefined);
});

test('the submit check leaves small scenes, other backends and rasterized jobs alone', () => {
  assert.equal(pathTraceTriangleProblem({ triangles: 400000 }, { type: 'pathTracer' }), undefined);
  assert.equal(pathTraceTriangleProblem({ triangles: 820000 }, { type: 'pathTracer', backend: 'gpu' }), undefined);
  assert.equal(pathTraceTriangleProblem({ triangles: 820000 }, { type: 'pathTracer', backend: 'native' }), undefined);
  assert.equal(pathTraceTriangleProblem({ triangles: 820000 }, undefined), undefined);
});

test('a review deadline says how far it got and how many shots to ask for', () => {
  const partway = reviewDeadlineMessage({ completedShots: 2, requestedShots: 4, deadlineSeconds: 30 });
  assert.match(partway, /^The review exceeded its total 30 second deadline after 2 of 4 shots\. Ask for at most 2 shots per call/);
  const first = reviewDeadlineMessage({ completedShots: 0, requestedShots: 3, deadlineSeconds: 30 });
  assert.match(first, /after 0 of 3 shots\. Ask for at most 1 shot per call/);
  const single = reviewDeadlineMessage({ completedShots: 0, requestedShots: 1, deadlineSeconds: 30 });
  assert.match(single, /Lower width and height, leave labels off/);
});

test('render and schemas.geometries stand for the topics jobs and geometries', async context => {
  const client = await connect(context);
  const render = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'render' } });
  assert.notEqual(render.isError, true);
  assert.equal(render.structuredContent.topic, 'jobs');
  const geometries = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'schemas.geometries' } });
  assert.notEqual(geometries.isError, true);
  assert.equal(geometries.structuredContent.topic, 'geometries');
});

test('an unknown topic suggests the nearest topic names', async context => {
  const client = await connect(context);
  const result = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'jobz' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown topic jobz\. Did you mean jobs\? Topics:/);
  const far = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'zzzzzzzz' } });
  assert.doesNotMatch(far.content[0].text, /Did you mean/);
});

test('the material pattern limit is listed in the capabilities flags', () => {
  assert.equal(AGENT_SCENE_CAPABILITIES.maxMaterialPatterns, 16);
});
