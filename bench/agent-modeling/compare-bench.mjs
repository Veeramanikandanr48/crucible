// Compare a candidate bench file against a baseline bench file, per model that appears in both:
//
// node bench/agent-modeling/compare-bench.mjs <baseline bench file> <candidate bench file> [--tolerance 0.05]
//
// Both files must come from the same skill mode (bench.mjs --skill-mode, recorded in each file; none when absent): comparing
// runs whose agents saw different system prompts is refused with exit 2.
//
// A candidate that ran only a subset of the tasks (bench.mjs --kinds, --topics or --tasks) is compared on those tasks alone: the
// baseline is cut down to the same tasks first, and the baseline tasks that did not run are listed as skipped. A skipped task
// is never a failure. Prints pass@1, pass^k, calls and tokens per run side by side, then the tasks whose pass count changed. Exits with 1
// when a model's pass@1 drops by more than the tolerance (default 0.05) or when infra runs pass --infra-bound (default 0.1) of its runs. With k runs per task, a swing of one run on
// one task is noise: judge a branch by the totals and by tasks that moved by two runs or more.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { benchTotals, zeroCallSummary } from './bench-summary.mjs';

const percent = value => (value === null || value === undefined ? '?' : `${Math.round(value * 100)}%`);
const signed = value => (value > 0 ? `+${value}` : String(value));

export const DEFAULT_INFRA_BOUND = 0.1;

/** The skill mode a bench file was run in; files from before skill modes were run without a skill. */
export const skillModeOf = benchFile => benchFile.skillMode ?? 'none';

/** Two runs in different skill modes differ in the system prompt, so their pass rates say nothing about a change. */
export function assertSameSkillMode(baseline, candidate) {
  const baselineMode = skillModeOf(baseline);
  const candidateMode = skillModeOf(candidate);
  if (baselineMode === candidateMode) return;
  throw new Error(`Cannot compare a ${baselineMode}-skill baseline with a ${candidateMode}-skill candidate: the agents saw different system prompts. Run base and head in the same skill mode (a change under skills/ uses --skill-mode references on both).`);
}

/** The baseline of one model cut down to the tasks the candidate ran: its totals and its per-task results. With the per-run
 * records the totals are recomputed exactly; without them only pass@1 can be, from the per-task pass counts. */
export function restrictBaseline(baseline, model, ranTasks) {
  const before = baseline.summary[model];
  const taskResults = Object.fromEntries(Object.entries(before.taskResults).filter(([task]) => ranTasks.has(task)));
  const records = baseline.recordsByModel?.[model];
  if (records) {
    const totals = benchTotals(records.filter(record => ranTasks.has(record.task)), baseline.runsPerTask);
    return { totals: { ...before, ...totals }, taskResults, exact: true };
  }
  const results = Object.values(taskResults);
  const runs = results.reduce((sum, result) => sum + result.runs, 0);
  const passed = results.reduce((sum, result) => sum + result.passed, 0);
  return { totals: { ...before, passAt1: runs ? Number((passed / runs).toFixed(3)) : null }, taskResults, exact: false };
}

/** Differences per model. Infra runs (no scene call because claude -p or the MCP server failed) are printed next to
 * pass@1 and are not in it; a model whose infra share passes `infraBound` in either file is flagged INFRA, since its
 * pass@1 then rests on too few runs, and that makes the comparison fail like a regression does. */
export function compareBench(baseline, candidate, tolerance = 0.05, infraBound = DEFAULT_INFRA_BOUND) {
  assertSameSkillMode(baseline, candidate);
  const lines = [];
  let regressed = false;
  let tooMuchInfra = false;
  for (const model of Object.keys(baseline.summary).filter(name => name in candidate.summary)) {
    const after = candidate.summary[model];
    const ranTasks = new Set(Object.keys(after.taskResults));
    const skipped = Object.keys(baseline.summary[model].taskResults).filter(task => !ranTasks.has(task));
    const { totals: before, taskResults: baselineTasks, exact } = skipped.length ? restrictBaseline(baseline, model, ranTasks) : { totals: baseline.summary[model], taskResults: baseline.summary[model].taskResults, exact: true };
    if (skipped.length) lines.push(`${model}: compared on ${ranTasks.size} tasks; ${skipped.length} baseline tasks skipped (not run, not failures): ${skipped.join(', ')}${exact ? '' : '. The baseline file has no per-run records, so only pass@1 is cut to those tasks and the other baseline numbers cover all tasks'}`);
    const drop = Number(((before.passAt1 ?? 0) - (after.passAt1 ?? 0)).toFixed(3));
    if (drop > tolerance) regressed = true;
    const overBound = (before.infraShare ?? 0) > infraBound || (after.infraShare ?? 0) > infraBound;
    if (overBound) tooMuchInfra = true;
    lines.push(`${model}: infra ${before.infraRuns ?? 0} -> ${after.infraRuns ?? 0} runs${overBound ? `  INFRA over ${percent(infraBound)} of runs` : ''}; pass@1 ${percent(before.passAt1)} -> ${percent(after.passAt1)}${drop > tolerance ? '  REGRESSION' : ''}, pass^k ${percent(before.passPowK)} -> ${percent(after.passPowK)}, calls/run ${before.callsPerRun} -> ${after.callsPerRun}, tokens in/run ${before.inputTokensPerRun} -> ${after.inputTokensPerRun}, tokens out/run ${before.outputTokensPerRun} -> ${after.outputTokensPerRun}`);
    for (const [name, totals] of [['baseline', before], ['candidate', after]]) {
      for (const text of zeroCallSummary(totals)) lines.push(`  ${name} ${text}`);
    }
    const tasks = new Set([...Object.keys(baselineTasks), ...Object.keys(after.taskResults)]);
    for (const task of tasks) {
      const passedBefore = baselineTasks[task]?.passed ?? 0;
      const passedAfter = after.taskResults[task]?.passed ?? 0;
      if (!baselineTasks[task]) lines.push(`  ${task}: no baseline, ${passedAfter}/${after.taskResults[task]?.runs ?? 0} (new task)`);
      else if (passedBefore !== passedAfter) lines.push(`  ${task}: ${passedBefore}/${baselineTasks[task]?.runs ?? 0} -> ${passedAfter}/${after.taskResults[task]?.runs ?? 0} (${signed(passedAfter - passedBefore)})`);
    }
  }
  return { regressed, tooMuchInfra, text: lines.join('\n') || 'No model appears in both files.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tolerance: { type: 'string', default: '0.05' }, 'infra-bound': { type: 'string', default: String(DEFAULT_INFRA_BOUND) } } });
  const [baselinePath, candidatePath] = positionals;
  const [baseline, candidate] = await Promise.all([baselinePath, candidatePath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  let result;
  try {
    result = compareBench(baseline, candidate, Number(values.tolerance), Number(values['infra-bound']));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  console.log(result.text);
  process.exitCode = result.regressed || result.tooMuchInfra ? 1 : 0;
}
