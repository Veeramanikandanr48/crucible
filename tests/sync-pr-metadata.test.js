import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findLinkedIssueNumberInBody, planMetadataChanges, syncMetadata } from '../scripts/sync-pr-metadata.mjs';

const pullRequestEvent = 'pull_request_target';
const linkedIssue = {
  number: 1944,
  milestone: { number: 6, title: '5 Agent surface' },
  labels: ['enhancement', 'goal:ai', 'priority:should'],
};

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/github-events/${name}.json`, import.meta.url), 'utf8'));
}

function planPullRequest(fixtureName, issue) {
  return planMetadataChanges({ eventName: pullRequestEvent, payload: loadFixture(fixtureName), linkedIssue: issue });
}

test('a pull request with a closing reference gets the issue milestone, priority, goal and the maintainer', () => {
  assert.deepEqual(planPullRequest('pull-request-closing-reference', linkedIssue), {
    milestone: { number: 6, title: '5 Agent surface' },
    addLabels: ['priority:should', 'goal:ai'],
    addAssignees: ['anxuanng'],
  });
});

test('a pull request with only Part of #N in the body is linked by the body parser', () => {
  const payload = loadFixture('pull-request-part-of');
  assert.equal(findLinkedIssueNumberInBody(payload.pull_request.body), 1944);
  assert.deepEqual(planPullRequest('pull-request-part-of', linkedIssue).addLabels, ['priority:should', 'goal:ai']);
});

test('the body parser reads Closes, Fixes and Resolves in any case and ignores other text', () => {
  assert.equal(findLinkedIssueNumberInBody('closes #12 and fixes #13'), 12);
  assert.equal(findLinkedIssueNumberInBody('RESOLVES #7'), 7);
  assert.equal(findLinkedIssueNumberInBody('see #5'), undefined);
  assert.equal(findLinkedIssueNumberInBody(null), undefined);
});

test('a pull request with no linked issue only gets the maintainer', () => {
  assert.deepEqual(planPullRequest('pull-request-no-link', undefined), { addLabels: [], addAssignees: ['anxuanng'] });
});

test('a pull request that already has every field plans nothing', () => {
  assert.deepEqual(planPullRequest('pull-request-complete', linkedIssue), { addLabels: [], addAssignees: [] });
});

test('a pull request with a priority label but no goal label gets only the goal label', () => {
  const plan = planPullRequest('pull-request-priority-only', linkedIssue);
  assert.deepEqual(plan.addLabels, ['goal:ai']);
  assert.equal(plan.milestone.title, '5 Agent surface');
});

test('an outside contributor pull request is assigned to the maintainer too', () => {
  assert.deepEqual(planPullRequest('pull-request-outside-contributor', undefined).addAssignees, ['anxuanng']);
});

test('an opened issue gets the maintainer only when nobody is assigned', () => {
  const unassigned = planMetadataChanges({ eventName: 'issues', payload: loadFixture('issue-opened-unassigned') });
  const assigned = planMetadataChanges({ eventName: 'issues', payload: loadFixture('issue-opened-assigned') });
  assert.deepEqual(unassigned, { addLabels: [], addAssignees: ['anxuanng'] });
  assert.deepEqual(assigned, { addLabels: [], addAssignees: [] });
});

test('malformed payloads and unknown events throw an error that says what to pass', () => {
  assert.throws(() => planPullRequest('pull-request-malformed', undefined), /pull_request\.number must be a positive integer/);
  assert.throws(() => planMetadataChanges({ eventName: pullRequestEvent, payload: {} }), /payload\.pull_request must be an object/);
  assert.throws(() => planMetadataChanges({ eventName: 'issues', payload: { issue: { number: 3 } } }), /issue\.assignees must be an array/);
  assert.throws(() => planMetadataChanges({ eventName: 'push', payload: {} }), /Unsupported event "push"/);
  assert.throws(() => planMetadataChanges({ eventName: pullRequestEvent, payload: null }), /payload must be an object/);
});

function createFakeFetch({ closingIssueNode, bodyIssue }) {
  const calls = [];
  async function fakeFetch(url, options) {
    const path = new URL(url).pathname;
    calls.push({ method: options.method, path, body: options.body ? JSON.parse(options.body) : undefined });
    const respond = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
    if (path === '/graphql') {
      return respond({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: closingIssueNode ? [closingIssueNode] : [] } } } } });
    }
    if (options.method === 'GET') {
      return bodyIssue ? respond(bodyIssue) : respond({ message: 'Not Found' }, 404);
    }
    return respond({});
  }
  return { fakeFetch, calls };
}

const closingIssueNode = {
  number: 1944,
  milestone: { number: 6, title: '5 Agent surface' },
  labels: { nodes: [{ name: 'goal:ai' }, { name: 'priority:should' }] },
};

function runSync(fixtureName, fetchSetup, eventName = pullRequestEvent) {
  const { fakeFetch, calls } = createFakeFetch(fetchSetup);
  const logLines = [];
  const promise = syncMetadata({
    eventName,
    payload: loadFixture(fixtureName),
    repository: 'codepawl/crucible',
    token: 'test-token',
    fetchImplementation: fakeFetch,
    log: (line) => logLines.push(line),
  });
  return { promise, calls, logLines };
}

test('the I/O layer applies the plan with PATCH and POST only, one log line per change', async () => {
  const { promise, calls, logLines } = runSync('pull-request-closing-reference', { closingIssueNode });
  await promise;
  const writes = calls.filter((call) => call.path !== '/graphql');
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), [
    'PATCH /repos/codepawl/crucible/issues/2001',
    'POST /repos/codepawl/crucible/issues/2001/labels',
    'POST /repos/codepawl/crucible/issues/2001/assignees',
  ]);
  assert.deepEqual(writes[0].body, { milestone: 6 });
  assert.deepEqual(writes[1].body, { labels: ['priority:should', 'goal:ai'] });
  assert.deepEqual(writes[2].body, { assignees: ['anxuanng'] });
  assert.equal(logLines.length, 4);
  assert.equal(calls.some((call) => call.method === 'DELETE' || call.path.includes('/comments')), false);
});

test('the I/O layer falls back to the issue named in the body and makes no write when nothing is missing', async () => {
  const bodyIssue = { number: 1944, milestone: { number: 6, title: '5 Agent surface' }, labels: [{ name: 'goal:ai' }] };
  const { promise, calls } = runSync('pull-request-complete', { bodyIssue });
  await promise;
  assert.ok(calls.some((call) => call.method === 'GET' && call.path.endsWith('/issues/1944')));
  assert.equal(calls.filter((call) => call.method !== 'GET' && call.path !== '/graphql').length, 0);
});

test('a body reference to a missing issue is treated as no link', async () => {
  const { promise, calls } = runSync('pull-request-part-of', {});
  await promise;
  const writes = calls.filter((call) => call.method !== 'GET' && call.path !== '/graphql');
  assert.deepEqual(writes.map((call) => call.path), ['/repos/codepawl/crucible/issues/2001/assignees']);
});

test('an issue event makes no GraphQL call', async () => {
  const { promise, calls } = runSync('issue-opened-unassigned', {}, 'issues');
  await promise;
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['POST /repos/codepawl/crucible/issues/2002/assignees']);
});

test('an API failure rejects with the status and path, and a missing token or repository is refused', async () => {
  const failingFetch = async () => ({ ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) });
  await assert.rejects(
    syncMetadata({ eventName: 'issues', payload: loadFixture('issue-opened-unassigned'), repository: 'codepawl/crucible', token: 't', fetchImplementation: failingFetch }),
    /POST \/repos\/codepawl\/crucible\/issues\/2002\/assignees failed with 403: forbidden/,
  );
  await assert.rejects(syncMetadata({ eventName: 'issues', payload: {}, repository: 'codepawl/crucible' }), /GITHUB_TOKEN is not set/);
  await assert.rejects(syncMetadata({ eventName: 'issues', payload: {}, repository: 'nope', token: 't' }), /owner\/name/);
});

const workflowText = readFileSync(new URL('../.github/workflows/sync-pr-metadata.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the workflow never checks out pull request code and holds exactly the agreed permissions', () => {
  assert.doesNotMatch(workflowText, /^\s*ref:/m);
  assert.doesNotMatch(workflowText, /github\.event\.pull_request\.head|head\.sha|head\.ref/);
  assert.doesNotMatch(workflowText, /npm ci/);
  const permissionsBlock = /^permissions:\n((?: {2}.+\n)+)/m.exec(workflowText)[1];
  assert.deepEqual(permissionsBlock.trim().split('\n').map((line) => line.trim()).sort(), ['contents: read', 'issues: write', 'pull-requests: write']);
  assert.match(workflowText, /pull_request_target:\n {4}types: \[opened, edited, reopened, ready_for_review\]/);
  assert.match(workflowText, /issues:\n {4}types: \[opened\]/);
  assert.match(workflowText, /concurrency:\n {2}group: sync-pr-metadata-/);
  assert.match(workflowText, /uses: actions\/checkout@[0-9a-f]{40}/);
});
