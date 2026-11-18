// The environment the bench gives the MCP server of a task tagged with the askUser topic (#1956): the path of the task's test-only
// answer file, so scene_ask_user answers from it instead of opening a browser. Any other task gets nothing.
import { join } from 'node:path';
import { ASK_USER_FIXTURE_VARIABLE } from '../../scripts/ask-user-fixture.mjs';
import { BENCH_TASKS } from './suite.mjs';

export function askUserEnvironment(task) {
  const topics = BENCH_TASKS.find(candidate => candidate.id === task.id)?.topics ?? [];
  if (!topics.includes('askUser')) return undefined;
  if (!task.askUserFixture) throw new Error(`Task ${task.id} has the askUser topic but no askUserFixture file name in its definition.`);
  return { [ASK_USER_FIXTURE_VARIABLE]: join(import.meta.dirname, task.askUserFixture) };
}
