import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { BENCH_TASKS, OPTIONAL_TASK_IDS } from '../bench/agent-modeling/suite.mjs';
import { BENCH_TOPICS, PATH_RULES, parseList, selectTasks, subsetCommand, suggestSubset } from '../bench/agent-modeling/subsets.mjs';
import { benchSummary } from '../bench/agent-modeling/bench-summary.mjs';
import { compareBench } from '../bench/agent-modeling/compare-bench.mjs';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';

const benchPath = new URL('../bench/agent-modeling/bench.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('parseList splits on commas and drops blanks', () => {
  assert.deepEqual(parseList(' look, light ,,'), ['look', 'light']);
  assert.deepEqual(parseList(undefined), []);
});

test('with no selection every task runs, in suite order', () => {
  assert.deepEqual(selectTasks({}, BENCH_TASKS), BENCH_TASKS.map(task => task.id));
});

test('--kinds selects by kind and --topics by topic tag', () => {
  assert.deepEqual(selectTasks({ kinds: 'light' }, BENCH_TASKS), ['render-pick', 'light-pick-hard', 'light-key-fill', 'light-spot-shadow']);
  assert.deepEqual(selectTasks({ topics: 'relations' }, BENCH_TASKS), ['kettle-resize', 'shelf-faces', 'desk-resize']);
  assert.ok(selectTasks({ topics: 'explosion' }, BENCH_TASKS).includes('explosion-blast'));
});

test('--tasks, --kinds and --topics add up as a union in suite order', () => {
  const ids = selectTasks({ tasks: 'bolt', kinds: 'film', topics: 'terrain' }, BENCH_TASKS);
  assert.deepEqual(ids, ['bolt', 'terrain-hole-walk', 'sunset-timelapse', 'film-reveal']);
});

test('an unknown task, kind or topic is an error that lists the valid ones', () => {
  assert.throws(() => selectTasks({ tasks: 'nope' }, BENCH_TASKS), /Unknown task nope\. Valid tasks: crate,/);
  assert.throws(() => selectTasks({ kinds: 'nope' }, BENCH_TASKS), /Unknown kind nope\. Valid kinds: modeling, revision/);
  assert.throws(() => selectTasks({ topics: 'nope' }, BENCH_TASKS), /Unknown topic nope\. Topics with a bench task: .*relations/);
  assert.throws(() => selectTasks({ topics: 'physics' }, BENCH_TASKS), /physics is a scene_capabilities topic that no bench task exercises yet/);
});

test('every topic tag and every topic of the path map is a scene_capabilities topic that some task carries', () => {
  const tagged = new Set(BENCH_TASKS.flatMap(task => task.topics ?? []));
  for (const topic of tagged) assert.ok(BENCH_TOPICS.includes(topic), topic);
  for (const rule of PATH_RULES) for (const topic of rule.topics ?? []) assert.ok(tagged.has(topic), `${topic} has no task`);
  const kinds = new Set(BENCH_TASKS.map(task => task.kind));
  for (const rule of PATH_RULES) for (const kind of rule.kinds ?? []) assert.ok(kinds.has(kind), kind);
});

test('suggestSubset maps paths to kinds and topics, and the shared files to the full bench', () => {
  const particles = suggestSubset(['src/agent-explosion.js', 'src/particles.js', 'tests/agent-explosion.test.js']);
  assert.deepEqual(particles.topics, ['explosion', 'particles']);
  assert.equal(particles.full, false);
  assert.deepEqual(particles.unmapped, ['tests/agent-explosion.test.js']);
  assert.deepEqual(suggestSubset(['src/motion.js']).kinds, ['animation', 'film', 'camera']);
  for (const path of ['scripts/mcp-server.mjs', 'skills/build-crucible-scene/SKILL.md']) {
    const shared = suggestSubset([path, 'src/particles.js']);
    assert.equal(shared.full, true, path);
    assert.deepEqual(shared.fullPaths, [path]);
  }
});

test('every local volume source file maps to the localVolumes topic, so its change benches the tasks that carry it', () => {
  const volumes = suggestSubset(['src/local-volumes.js', 'src/local-volume-noise.js', 'src/local-volume-resolve.js']);
  assert.deepEqual(volumes.topics, ['localVolumes']);
  assert.deepEqual(volumes.unmapped, []);
  assert.equal(volumes.full, false);
  assert.deepEqual(suggestSubset(['src/local-volumes-extra/x.js']).topics ?? [], []);
});

test('subsetCommand prints the full command, a subset command or no command', () => {
  assert.doesNotMatch(subsetCommand(suggestSubset(['scripts/mcp-server.mjs']), 'x').command, /--kinds|--topics/);
  assert.match(subsetCommand(suggestSubset(['src/agent-relations.js', 'src/agent-look.js']), 'x').command, /--kinds look,light --topics relations$/);
  assert.equal(subsetCommand(suggestSubset(['README.md'])).command, null);
});

test('bench.mjs --dry-run lists the selected tasks and rejects unknown values without running claude', () => {
  const output = execFileSync(process.execPath, [benchPath, '--kinds', 'film', '--dry-run'], { encoding: 'utf8' });
  assert.match(output, /^2 of \d+ tasks: sunset-timelapse, film-reveal/);
  assert.throws(() => execFileSync(process.execPath, [benchPath, '--topics', 'nope', '--dry-run'], { encoding: 'utf8', stdio: 'pipe' }), /Unknown topic nope/);
});

test('--tasks accepts a scene task that the default run leaves out, and the default run stays on the 33 bench tasks', () => {
  assert.deepEqual(OPTIONAL_TASK_IDS, ['findings-fix']);
  assert.deepEqual(selectTasks({ tasks: 'findings-fix' }, BENCH_TASKS, OPTIONAL_TASK_IDS), ['findings-fix']);
  assert.deepEqual(selectTasks({ tasks: 'findings-fix,bolt' }, BENCH_TASKS, OPTIONAL_TASK_IDS), ['bolt', 'findings-fix']);
  assert.equal(selectTasks({}, BENCH_TASKS, OPTIONAL_TASK_IDS).length, 33);
  assert.equal(selectTasks({ kinds: 'light' }, BENCH_TASKS, OPTIONAL_TASK_IDS).includes('findings-fix'), false);
  assert.throws(() => selectTasks({ tasks: 'nope' }, BENCH_TASKS, OPTIONAL_TASK_IDS), /Unknown task nope\. Valid tasks: crate,.*findings-fix\./);
});

test('bench.mjs --tasks findings-fix --dry-run selects it, an unknown id lists the valid ids, the default dry run selects 33 tasks', () => {
  const run = argumentsList => execFileSync(process.execPath, [benchPath, ...argumentsList, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(run(['--tasks', 'findings-fix']), /^1 of 33 tasks: findings-fix/);
  assert.match(run([]), /^33 of 33 tasks: crate,/);
  assert.throws(() => run(['--tasks', 'nope']), /Unknown task nope\. Valid tasks: crate,.*findings-fix\./s);
});

function record(task, pass, extra = {}) {
  return { task, attempt: 1, pass, toolCalls: 4, toolErrors: 0, inputTokens: 100, outputTokens: 10, wallSeconds: 5, ...extra };
}

function benchFile(records) {
  return { bench: 'x', runsPerTask: 1, tasks: [...new Set(records.map(item => item.task))], summary: benchSummary({ haiku: records }, 1), recordsByModel: { haiku: records } };
}

test('compare-bench judges a subset run on its tasks only and lists the skipped baseline tasks', () => {
  const baseline = benchFile([record('crate', true), record('bolt', true), record('look-fog', true), record('film-reveal', false)]);
  const candidate = benchFile([record('look-fog', true), record('film-reveal', false)]);
  const result = compareBench(baseline, candidate);
  assert.equal(result.regressed, false);
  assert.match(result.text, /compared on 2 tasks; 2 baseline tasks skipped \(not run, not failures\): crate, bolt/);
  assert.match(result.text, /pass@1 50% -> 50%/);
});

test('compare-bench still flags a regression among the tasks that ran, and marks a task with no baseline as new', () => {
  const baseline = benchFile([record('crate', true), record('look-fog', true), record('film-reveal', true)]);
  const candidate = benchFile([record('look-fog', false), record('explosion-blast', true)]);
  const result = compareBench(baseline, candidate);
  assert.equal(result.regressed, true);
  assert.match(result.text, /look-fog: 1\/1 -> 0\/1/);
  assert.match(result.text, /explosion-blast: no baseline, 1\/1 \(new task\)/);
});

test('compare-bench cuts pass@1 of a baseline without per-run records to the tasks that ran', () => {
  const baseline = benchFile([record('crate', false), record('look-fog', true)]);
  delete baseline.recordsByModel;
  const result = compareBench(baseline, benchFile([record('look-fog', true)]));
  assert.equal(result.regressed, false);
  assert.match(result.text, /pass@1 100% -> 100%/);
  assert.match(result.text, /only pass@1 is cut/);
});

test('the explosion-blast task passes with its reference and rejects a missing, far or unlooked blast', async () => {
  const task = taskById('explosion-blast');
  assert.equal((await gradeRecipe(task, REFERENCES['explosion-blast'], { scene_look: 1 })).pass, true);
  const failed = async (recipe, tools) => (await gradeRecipe(task, recipe, tools)).results.filter(result => !result.pass).map(result => result.label ?? result.kind);
  assert.deepEqual(await failed(REFERENCES['explosion-blast'], { scene_apply: 3 }), ['toolCalled']);
  const noBlast = structuredClone(REFERENCES['explosion-blast']);
  delete noBlast.environment;
  assert.deepEqual(await failed(noBlast, { scene_look: 1 }), ['blast between the pillars']);
  const farBlast = structuredClone(REFERENCES['explosion-blast']);
  farBlast.environment.localVolumes[0].center = [3.5, 2, 0];
  assert.deepEqual(await failed(farBlast, { scene_look: 1 }), ['blast between the pillars']);
  const movedPillar = structuredClone(REFERENCES['explosion-blast']);
  movedPillar.nodes.find(node => node.id === 'pillar-2').translation = [1, 1.5, -2.5];
  assert.deepEqual(await failed(movedPillar, { scene_look: 1 }), ['floor and pillars untouched']);
  const noFloor = structuredClone(REFERENCES['explosion-blast']);
  noFloor.nodes = noFloor.nodes.filter(node => node.id !== 'floor');
  assert.deepEqual(await failed(noFloor, { scene_look: 1 }), ['floor and pillars untouched']);
});
