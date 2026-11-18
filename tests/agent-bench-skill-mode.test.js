import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BENCH_TASKS, KIND_REFERENCES, NOT_LOADED_REFERENCES, TOPIC_REFERENCES, kindsLoadingReference, referencesForTask } from '../bench/agent-modeling/suite.mjs';
import { resolveSkillMode, skillPromptFor } from '../bench/agent-modeling/skill-prompt.mjs';
import { subsetCommand, suggestSubset } from '../bench/agent-modeling/subsets.mjs';
import { compareBench } from '../bench/agent-modeling/compare-bench.mjs';

const repository = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const referencesDirectory = join(repository, 'skills', 'build-crucible-scene', 'references');
const benchPath = join(repository, 'bench', 'agent-modeling', 'bench.mjs');

test('every reference file is loaded by some task kind or topic, or listed as not loaded with a reason', async () => {
  const files = (await readdir(referencesDirectory)).filter(name => name.endsWith('.md'));
  const loaded = new Set([...Object.values(KIND_REFERENCES).flat(), ...Object.values(TOPIC_REFERENCES).flat()]);
  for (const file of files) {
    const reachable = loaded.has(file);
    const excused = typeof NOT_LOADED_REFERENCES[file] === 'string' && NOT_LOADED_REFERENCES[file].length > 0;
    assert.ok(reachable !== excused, `${file} must be loaded by a kind in KIND_REFERENCES or TOPIC_REFERENCES (suite.mjs), or listed once in NOT_LOADED_REFERENCES with a reason`);
  }
  for (const name of [...loaded, ...Object.keys(NOT_LOADED_REFERENCES)]) assert.ok(files.includes(name), `${name} is named in suite.mjs but is not under skills/build-crucible-scene/references/`);
  for (const task of BENCH_TASKS) assert.ok(KIND_REFERENCES[task.kind], `kind ${task.kind} has no entry in KIND_REFERENCES`);
});

test('a one-line change in light.md reaches the prompt of a light task and not of a look task', async () => {
  const temporaryRepository = await mkdtemp(join(tmpdir(), 'skill-mode-'));
  try {
    await mkdir(join(temporaryRepository, 'skills'), { recursive: true });
    await cp(join(repository, 'skills', 'build-crucible-scene'), join(temporaryRepository, 'skills', 'build-crucible-scene'), { recursive: true });
    const lightPath = join(temporaryRepository, 'skills', 'build-crucible-scene', 'references', 'light.md');
    const marker = 'SKILL-MODE-TEST-MARKER spot cones never exceed 90 degrees';
    await writeFile(lightPath, `${await readFile(lightPath, 'utf8')}\n${marker}\n`);
    const lightTask = BENCH_TASKS.find(task => task.kind === 'light');
    const lookTask = BENCH_TASKS.find(task => task.kind === 'look');
    assert.ok((await skillPromptFor('references', lightTask, temporaryRepository)).includes(marker));
    assert.ok(!(await skillPromptFor('references', lookTask, temporaryRepository)).includes(marker));
    assert.ok(!(await skillPromptFor('legacy', lightTask, temporaryRepository)).includes(marker), 'the legacy mode never carried light.md');
    assert.equal(await skillPromptFor('none', lightTask, temporaryRepository), null);
  } finally {
    await rm(temporaryRepository, { recursive: true, force: true });
  }
});

test('a task prompt starts with SKILL.md and carries the references of its kind and topics', async () => {
  const task = BENCH_TASKS.find(candidate => candidate.id === 'robot-shot');
  assert.deepEqual(referencesForTask(task), ['camera.md', 'errors-and-recovery.md', 'film-and-animation.md', 'game.md']);
  const prompt = await skillPromptFor('references', task, repository);
  assert.ok(prompt.startsWith((await readFile(join(referencesDirectory, '..', 'SKILL.md'), 'utf8'))));
  assert.ok(prompt.includes(await readFile(join(referencesDirectory, 'game.md'), 'utf8')));
  assert.ok(!prompt.includes(await readFile(join(referencesDirectory, 'light.md'), 'utf8')));
  assert.deepEqual(kindsLoadingReference('light.md'), ['light']);
  assert.deepEqual(kindsLoadingReference('scene-contract.md'), []);
});

test('resolveSkillMode keeps --skill as legacy and rejects unknown or conflicting modes', () => {
  assert.equal(resolveSkillMode({}), 'none');
  assert.equal(resolveSkillMode({ skill: true }), 'legacy');
  assert.equal(resolveSkillMode({ skillMode: 'references' }), 'references');
  assert.throws(() => resolveSkillMode({ skillMode: 'all' }), /--skill-mode must be one of none, legacy, references/);
  assert.throws(() => resolveSkillMode({ skill: true, skillMode: 'references' }), /conflicts/);
});

function benchFileWith(skillMode) {
  const summary = { haiku: { passAt1: 1, passPowK: 1, callsPerRun: 5, inputTokensPerRun: 1, outputTokensPerRun: 1, taskResults: { bolt: { passed: 3, runs: 3 } } } };
  return { summary, ...(skillMode ? { skillMode } : {}) };
}

test('compareBench refuses runs made in different skill modes and accepts the same mode', () => {
  assert.throws(() => compareBench(benchFileWith(), benchFileWith('references')), /Cannot compare a none-skill baseline with a references-skill candidate/);
  assert.throws(() => compareBench(benchFileWith('legacy'), benchFileWith('references')), /same skill mode/);
  assert.match(compareBench(benchFileWith('references'), benchFileWith('references')).text, /pass@1 100% -> 100%/);
  assert.match(compareBench(benchFileWith(), benchFileWith('none')).text, /haiku/, 'a file without the field counts as none');
});

test('suggestSubset picks skill mode references for a skills/ change and the kinds that load the changed reference', () => {
  const light = suggestSubset(['skills/build-crucible-scene/references/light.md']);
  assert.equal(light.skillMode, 'references');
  assert.equal(light.full, false);
  assert.deepEqual(light.kinds, ['light']);
  assert.match(subsetCommand(light, 'x').command, /--skill-mode references --kinds light$/);
  const entry = suggestSubset(['skills/build-crucible-scene/SKILL.md']);
  assert.equal(entry.full, true);
  assert.match(subsetCommand(entry, 'x').command, /--skill-mode references$/);
  assert.equal(suggestSubset(['skills/build-crucible-scene/references/scene-contract.md']).unmapped.length, 1);
  assert.equal(suggestSubset(['src/agent-relations.js']).skillMode, null);
  assert.doesNotMatch(subsetCommand(suggestSubset(['scripts/mcp-server.mjs']), 'x').command, /--skill-mode/);
});

test('bench.mjs --suggest prints the skill mode and the same-mode base advice, and --dry-run rejects an unknown mode', () => {
  // HEAD as the base: CI checks out one commit with no origin/main, and an empty diff still prints the summary line.
  const output = execFileSync(process.execPath, [benchPath, '--suggest', 'HEAD', '--dry-run'], { cwd: repository, encoding: 'utf8' });
  assert.match(output, /changed files against/);
  assert.throws(() => execFileSync(process.execPath, [benchPath, '--skill-mode', 'bogus', '--dry-run'], { cwd: repository, encoding: 'utf8', stdio: 'pipe' }), /--skill-mode must be one of/);
  const dryRun = execFileSync(process.execPath, [benchPath, '--skill-mode', 'references', '--kinds', 'light', '--dry-run'], { cwd: repository, encoding: 'utf8' });
  assert.match(dryRun, /^4 of \d+ tasks: render-pick/);
});
