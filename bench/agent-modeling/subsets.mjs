// Which bench tasks a change can affect (issue #1791: "bench what changed, not everything again and again").
// A one-topic change runs only its related tasks; a change every task reads (the MCP server file with the tool schemas and
// the server instructions, or a skill) runs the full bench, and so does the last run before a release cut.
import { AGENT_SCENE_CAPABILITIES } from '../../src/agent-scene-capabilities.js';
import { kindsLoadingReference } from './suite.mjs';

/** The topic names of scene_capabilities that a task can be tagged with. */
export const BENCH_TOPICS = Object.freeze(Object.keys(AGENT_SCENE_CAPABILITIES).filter(name => !['boolean', 'number'].includes(typeof AGENT_SCENE_CAPABILITIES[name])));

const SCENE_SKILL_PATH = /^skills\/build-crucible-scene\//;
const SCENE_SKILL_REFERENCE = /^skills\/build-crucible-scene\/references\/([a-z-]+\.md)$/;

export const FULL_BENCH_PATHS =[/^skills\//, /^scripts\/mcp-server\.mjs$/, /^\.claude-plugin\//];

// First match wins for each path; a path can add kinds, topics or both. Paths with no rule are listed as unmapped.
export const PATH_RULES = [
  { pattern: /^src\/(agent-explosion|explosion-[a-z-]+)\.js$/, topics: ['explosion'] },
  { pattern: /^src\/(agent-particles|particles|particle-[a-z-]+)\.js$/, topics: ['particles'] },
  { pattern: /^src\/(volume-grid[a-z-]*|volumetric|local-volume[a-z-]*)\.js$/, topics: ['localVolumes'] },
  { pattern: /^src\/agent-relations\.js$/, topics: ['relations'] },
  { pattern: /^src\/(agent-terrain|terrain[a-z-]*)\.js$/, topics: ['terrain'] },
  { pattern: /^src\/(agent-motion|motion[a-z-]*|agent-clip-layers)\.js$/, kinds: ['animation', 'film', 'camera'] },
  { pattern: /^src\/(rig|rig-presets|agent-retarget)\.js$/, topics: ['motionIk'] },
  { pattern: /^src\/mesh-uv[a-z-]*\.js$/, topics: ['meshUv'] },
  { pattern: /^src\/(mesh|agent-mesh)[a-z-]*\.js$/, kinds: ['modeling', 'revision'] },
  { pattern: /^src\/(agent-look|agent-reflections)\.js$/, kinds: ['look', 'light'] },
  { pattern: /^src\/(agent-scene-assets|agent-asset[a-z-]*)\.js$/, topics: ['placedAssets'] },
];

/** Split a comma list; an empty or missing value is an empty list. */
export function parseList(text) {
  return (text ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * The task ids a run selects. --tasks, --kinds and --topics add to each other (a union); none given selects every task, in suite order.
 * --tasks also accepts the ids in `optionalTaskIds` (tasks that exist but stay out of the default run); they come after the suite tasks, in the order named.
 */
export function selectTasks({ tasks, kinds, topics }, benchTasks, optionalTaskIds = []) {
  const wantedTasks = parseList(tasks);
  const wantedKinds = parseList(kinds);
  const wantedTopics = parseList(topics);
  const suiteIds = benchTasks.map(task => task.id);
  const knownIds = [...suiteIds, ...optionalTaskIds.filter(id => !suiteIds.includes(id))];
  const knownKinds = [...new Set(benchTasks.map(task => task.kind))];
  const unknownIds = wantedTasks.filter(id => !knownIds.includes(id));
  if (unknownIds.length) throw new RangeError(`Unknown task ${unknownIds.join(', ')}. Valid tasks: ${knownIds.join(', ')}.`);
  const unknownKinds = wantedKinds.filter(kind => !knownKinds.includes(kind));
  if (unknownKinds.length) throw new RangeError(`Unknown kind ${unknownKinds.join(', ')}. Valid kinds: ${knownKinds.join(', ')}.`);
  const taggedTopics = [...new Set(benchTasks.flatMap(task => task.topics ?? []))];
  const unknownTopics = wantedTopics.filter(topic => !taggedTopics.includes(topic));
  if (unknownTopics.length) {
    const untagged = unknownTopics.filter(topic => BENCH_TOPICS.includes(topic));
    const detail = untagged.length ? ` ${untagged.join(', ')} is a scene_capabilities topic that no bench task exercises yet.` : '';
    throw new RangeError(`Unknown topic ${unknownTopics.join(', ')}.${detail} Topics with a bench task: ${taggedTopics.join(', ')}.`);
  }
  if (!wantedTasks.length && !wantedKinds.length && !wantedTopics.length) return suiteIds;
  const selectedSuiteIds = benchTasks
    .filter(task => wantedTasks.includes(task.id) || wantedKinds.includes(task.kind) || (task.topics ?? []).some(topic => wantedTopics.includes(topic)))
    .map(task => task.id);
  const selectedOptionalIds = wantedTasks.filter(id => !suiteIds.includes(id));
  return [...selectedSuiteIds, ...new Set(selectedOptionalIds)];
}

/** What the changed paths ask of the bench: { full, fullPaths, kinds, topics, unmapped }. */
export function suggestSubset(changedPaths) {
  const kinds = new Set();
  const topics = new Set();
  const fullPaths = [];
  const unmapped = [];
  let skillMode = null;
  for (const path of changedPaths) {
    if (SCENE_SKILL_PATH.test(path)) {
      // The bench agent only sees the skill when a run loads it, so a skill change is benched in skill mode `references`.
      skillMode = 'references';
      const referenceName = path.match(SCENE_SKILL_REFERENCE)?.[1];
      if (!referenceName) {
        fullPaths.push(path);
        continue;
      }
      const loadingKinds = kindsLoadingReference(referenceName);
      if (loadingKinds.length === 0) unmapped.push(path);
      for (const kind of loadingKinds) kinds.add(kind);
      continue;
    }
    if (FULL_BENCH_PATHS.some(pattern => pattern.test(path))) {
      fullPaths.push(path);
      continue;
    }
    const rule = PATH_RULES.find(candidate => candidate.pattern.test(path));
    if (!rule) {
      unmapped.push(path);
      continue;
    }
    for (const kind of rule.kinds ?? []) kinds.add(kind);
    for (const topic of rule.topics ?? []) topics.add(topic);
  }
  return { full: fullPaths.length > 0, fullPaths, kinds: [...kinds], topics: [...topics], unmapped, skillMode };
}

/** The bench command line (and a one-line reason) for a suggestion. */
export function subsetCommand(suggestion, label = '<branch>') {
  const skillFlag = suggestion.skillMode ? ` --skill-mode ${suggestion.skillMode}` : '';
  const base = `node bench/agent-modeling/bench.mjs --models haiku --runs 3 --label ${label} --backend cpu${skillFlag}`;
  if (suggestion.full) return { reason: `full bench: ${suggestion.fullPaths.join(', ')} is read by every task`, command: base };
  const flags = [
    ...(suggestion.kinds.length ? [`--kinds ${suggestion.kinds.join(',')}`] : []),
    ...(suggestion.topics.length ? [`--topics ${suggestion.topics.join(',')}`] : []),
  ];
  if (!flags.length) return { reason: 'no changed path maps to a bench task; name the related task ids with --tasks, or write why no task applies', command: null };
  return { reason: 'subset: only the tasks these changes can affect', command: `${base} ${flags.join(' ')}` };
}

/** Extra lines for a skill change: the base ref must run in the same skill mode, since the stored baseline has no skill. */
export function skillModeAdvice(suggestion, command, baseRef) {
  if (!suggestion.skillMode || !command) return [];
  return [
    `Skill change: bench base and head in the same skill mode (${suggestion.skillMode}), not against the stored no-skill baseline.`,
    `Run the command above in a worktree of ${baseRef} with --label base, then compare-bench.mjs results/bench-base.json results/bench-<head label>.json (it refuses runs in different skill modes).`,
  ];
}
