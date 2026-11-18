#!/usr/bin/env node
// Fills the assignee, milestone and labels of new pull requests and issues (#1944).
// planMetadataChanges is pure: event in, planned additions out. The I/O layer below it talks to the GitHub API with fetch.
// It only ever adds things: no DELETE call, no comment. Run by .github/workflows/sync-pr-metadata.yml, which never checks out PR code.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAINTAINER_LOGIN = 'anxuanng';
const PRIORITY_PREFIX = 'priority:';
const GOAL_PREFIX = 'goal:';
const LINK_PATTERN = /\b(?:part of|closes?|closed|fix(?:es|ed)?|resolves?|resolved)\s+#(\d+)/i;
const PULL_REQUEST_EVENT = 'pull_request_target';
const ISSUE_EVENT = 'issues';

export function findLinkedIssueNumberInBody(body) {
  if (typeof body !== 'string') {
    return undefined;
  }
  const match = LINK_PATTERN.exec(body);
  return match ? Number(match[1]) : undefined;
}

function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object; pass the parsed GitHub event payload.`);
  }
  return value;
}

function requireItemNumber(item, description) {
  if (!Number.isInteger(item.number) || item.number < 1) {
    throw new Error(`${description}.number must be a positive integer; got ${JSON.stringify(item.number)}.`);
  }
}

function requireArrayField(item, field, description) {
  if (!Array.isArray(item[field])) {
    throw new Error(`${description}.${field} must be an array; got ${JSON.stringify(item[field])}.`);
  }
}

function hasLabelWithPrefix(labelNames, prefix) {
  return labelNames.some((name) => name.startsWith(prefix));
}

function labelsToAddFromIssue(linkedIssueLabelNames, pullRequestLabelNames) {
  const labelsToAdd = [];
  for (const prefix of [PRIORITY_PREFIX, GOAL_PREFIX]) {
    if (hasLabelWithPrefix(pullRequestLabelNames, prefix)) {
      continue;
    }
    labelsToAdd.push(...linkedIssueLabelNames.filter((name) => name.startsWith(prefix)));
  }
  return labelsToAdd;
}

function planPullRequest(payload, linkedIssue) {
  const pullRequest = requireObject(payload.pull_request, 'payload.pull_request');
  requireItemNumber(pullRequest, 'payload.pull_request');
  requireArrayField(pullRequest, 'labels', 'payload.pull_request');
  requireArrayField(pullRequest, 'assignees', 'payload.pull_request');
  const plan = { addLabels: [], addAssignees: [] };
  if (pullRequest.assignees.length === 0) {
    plan.addAssignees.push(MAINTAINER_LOGIN);
  }
  if (!linkedIssue) {
    return plan;
  }
  const pullRequestLabelNames = pullRequest.labels.map((label) => label.name);
  const linkedIssueLabelNames = (linkedIssue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name));
  plan.addLabels = labelsToAddFromIssue(linkedIssueLabelNames, pullRequestLabelNames);
  if (!pullRequest.milestone && linkedIssue.milestone) {
    plan.milestone = { number: linkedIssue.milestone.number, title: linkedIssue.milestone.title };
  }
  return plan;
}

function planIssue(payload) {
  const issue = requireObject(payload.issue, 'payload.issue');
  requireItemNumber(issue, 'payload.issue');
  requireArrayField(issue, 'assignees', 'payload.issue');
  const plan = { addLabels: [], addAssignees: [] };
  if (issue.assignees.length === 0) {
    plan.addAssignees.push(MAINTAINER_LOGIN);
  }
  return plan;
}

/** eventName is GITHUB_EVENT_NAME, payload the event JSON, linkedIssue `{ number, milestone, labels }` or undefined. */
export function planMetadataChanges({ eventName, payload, linkedIssue }) {
  requireObject(payload, 'payload');
  if (eventName === PULL_REQUEST_EVENT) {
    return planPullRequest(payload, linkedIssue);
  }
  if (eventName === ISSUE_EVENT) {
    return planIssue(payload);
  }
  throw new Error(`Unsupported event "${eventName}"; use ${PULL_REQUEST_EVENT} or ${ISSUE_EVENT}.`);
}

export function describePlan(itemNumber, plan) {
  const lines = [];
  if (plan.milestone) {
    lines.push(`#${itemNumber}: set milestone "${plan.milestone.title}"`);
  }
  for (const label of plan.addLabels) {
    lines.push(`#${itemNumber}: add label ${label}`);
  }
  for (const login of plan.addAssignees) {
    lines.push(`#${itemNumber}: assign ${login}`);
  }
  return lines;
}

function createGitHubClient({ token, fetchImplementation, apiUrl }) {
  async function send(method, path, body) {
    const response = await fetchImplementation(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'crucible-sync-pr-metadata',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`GitHub ${method} ${path} failed with ${response.status}: ${detail}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  return {
    get: (path) => send('GET', path),
    patch: (path, body) => send('PATCH', path, body),
    post: (path, body) => send('POST', path, body),
  };
}

const CLOSING_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 1) {
        nodes { number milestone { number title } labels(first: 50) { nodes { name } } }
      }
    }
  }
}`;

async function findClosingIssue(client, repository, pullRequestNumber) {
  const [owner, name] = repository.split('/');
  const result = await client.post('/graphql', { query: CLOSING_ISSUES_QUERY, variables: { owner, name, number: pullRequestNumber } });
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(result.errors)}`);
  }
  const node = result.data?.repository?.pullRequest?.closingIssuesReferences?.nodes?.[0];
  if (!node) {
    return undefined;
  }
  return { number: node.number, milestone: node.milestone, labels: node.labels.nodes.map((label) => label.name) };
}

async function findIssueNamedInBody(client, repository, body) {
  const issueNumber = findLinkedIssueNumberInBody(body);
  if (issueNumber === undefined) {
    return undefined;
  }
  try {
    const issue = await client.get(`/repos/${repository}/issues/${issueNumber}`);
    return { number: issue.number, milestone: issue.milestone, labels: issue.labels.map((label) => label.name) };
  } catch (error) {
    if (error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function findLinkedIssue(client, repository, payload) {
  const pullRequest = payload.pull_request;
  return (await findClosingIssue(client, repository, pullRequest.number)) ?? (await findIssueNamedInBody(client, repository, pullRequest.body));
}

async function applyPlan(client, repository, itemNumber, plan) {
  const itemPath = `/repos/${repository}/issues/${itemNumber}`;
  if (plan.milestone) {
    await client.patch(itemPath, { milestone: plan.milestone.number });
  }
  if (plan.addLabels.length > 0) {
    await client.post(`${itemPath}/labels`, { labels: plan.addLabels });
  }
  if (plan.addAssignees.length > 0) {
    await client.post(`${itemPath}/assignees`, { assignees: plan.addAssignees });
  }
}

export async function syncMetadata({ eventName, payload, repository, token, fetchImplementation = fetch, apiUrl = 'https://api.github.com', log = console.log }) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set; pass the workflow token in the environment.');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error(`GITHUB_REPOSITORY must look like owner/name; got ${JSON.stringify(repository)}.`);
  }
  requireObject(payload, 'payload');
  const client = createGitHubClient({ token, fetchImplementation, apiUrl });
  const isPullRequest = eventName === PULL_REQUEST_EVENT && payload.pull_request;
  const linkedIssue = isPullRequest ? await findLinkedIssue(client, repository, payload) : undefined;
  const plan = planMetadataChanges({ eventName, payload, linkedIssue });
  const itemNumber = (payload.pull_request ?? payload.issue).number;
  const lines = describePlan(itemNumber, plan);
  await applyPlan(client, repository, itemNumber, plan);
  lines.forEach((line) => log(line));
  return plan;
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set; point it at the event JSON file.');
  }
  await syncMetadata({
    eventName: process.env.GITHUB_EVENT_NAME,
    payload: JSON.parse(readFileSync(eventPath, 'utf8')),
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
