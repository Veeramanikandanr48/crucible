import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_PROMPT_FILE, claudeArguments, writeSkillPromptFile } from '../bench/agent-modeling/claude-arguments.mjs';
import { skillPromptFor } from '../bench/agent-modeling/skill-prompt.mjs';
import { BENCH_TASKS } from '../bench/agent-modeling/suite.mjs';
import { PROMPT_PREAMBLE, taskById, taskPrompt } from '../bench/agent-modeling/tasks.mjs';

const repository = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Windows refuses a command line over 32,767 characters (#1939); no single argument should come near it.
const LONGEST_ARGUMENT = 8 * 1024;
const WINDOWS_COMMAND_LINE_LIMIT = 32767;

function argumentsFor(task, skillPromptPath) {
  const text = taskPrompt(task);
  const prompt = task.ownPreamble ? text : `${PROMPT_PREAMBLE}\n\n${text}`;
  return claudeArguments({ prompt, model: 'haiku', configPath: 'mcp.json', serverName: 'crucible', builtInTools: ['Bash', 'Read'], skillPromptPath });
}

test('every bench task in references mode passes its skill prompt as a file and keeps each argument short (#1939)', async context => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'crucible-claude-arguments-'));
  context.after(() => rm(workingDirectory, { recursive: true, force: true }));
  for (const { id: taskId } of BENCH_TASKS) {
    const task = taskById(taskId);
    const skillPrompt = await skillPromptFor('references', task, repository);
    assert.ok(skillPrompt.length > 0, `${taskId} loads a skill prompt in references mode`);
    const skillPromptPath = await writeSkillPromptFile(workingDirectory, skillPrompt);
    assert.equal(skillPromptPath, join(workingDirectory, SKILL_PROMPT_FILE));
    assert.equal(await readFile(skillPromptPath, 'utf8'), skillPrompt);
    const argumentsList = argumentsFor(task, skillPromptPath);
    const flagIndex = argumentsList.indexOf('--append-system-prompt-file');
    assert.equal(argumentsList[flagIndex + 1], skillPromptPath, `${taskId} names the prompt file`);
    assert.ok(!argumentsList.includes('--append-system-prompt'), `${taskId} has no inline system prompt flag`);
    assert.ok(!argumentsList.includes(skillPrompt), `${taskId} does not carry the skill text inline`);
    const longest = Math.max(...argumentsList.map(argument => argument.length));
    assert.ok(longest < LONGEST_ARGUMENT, `${taskId}: longest argument is ${longest} characters`);
    assert.ok(argumentsList.join(' ').length < WINDOWS_COMMAND_LINE_LIMIT, `${taskId} fits a Windows command line`);
  }
});

test('run.mjs builds its claude arguments with claudeArguments and never passes the skill text inline', async () => {
  const runSource = await readFile(join(repository, 'bench', 'agent-modeling', 'run.mjs'), 'utf8');
  assert.match(runSource, /claudeArguments\(\{/);
  assert.match(runSource, /writeSkillPromptFile\(workingDirectory/);
  assert.doesNotMatch(runSource, /'--append-system-prompt'/);
});

test('a run without a skill prompt writes no file and passes no prompt flag', async context => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'crucible-claude-arguments-'));
  context.after(() => rm(workingDirectory, { recursive: true, force: true }));
  assert.equal(await writeSkillPromptFile(workingDirectory, ''), null);
  const argumentsList = argumentsFor(taskById(BENCH_TASKS[0].id), null);
  assert.ok(!argumentsList.some(argument => argument.startsWith('--append-system-prompt')));
});
