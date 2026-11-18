// The agent bench: the tasks that make up one bench run, each tagged with the kind of work it tests. Ids come from
// tasks.mjs (every one has a reference solution and an automatic grader). SMOKE_TASKS is the two-task subset used to
// prove the pipeline end to end without paying for a full run.
//
// `topics` names the scene_capabilities topics a task clearly exercises, only where it does. bench.mjs --kinds and --topics
// select tasks by `kind` and `topics`, so a one-topic change runs only its related tasks (subsets.mjs).

import { SCENE_TASKS } from './scenes.mjs';

export const BENCH_TASKS = [
  { id: 'crate', kind: 'modeling', topics: ['meshEdits'] },
  { id: 'bolt', kind: 'modeling' },
  { id: 'table', kind: 'modeling' },
  { id: 'mug', kind: 'modeling' },
  { id: 'gear', kind: 'modeling' },
  { id: 'pillar-court', kind: 'modeling' },
  { id: 'chair', kind: 'modeling' },
  { id: 'crate-uv', kind: 'modeling', topics: ['meshUv'] },
  { id: 'crate-revision', kind: 'revision' },
  { id: 'bracket-revision', kind: 'revision' },
  { id: 'kettle-resize', kind: 'revision', topics: ['relations'] },
  { id: 'workshop', kind: 'scene' },
  { id: 'shelf-faces', kind: 'scene', topics: ['relations'] },
  { id: 'desk-resize', kind: 'scene', topics: ['relations'] },
  { id: 'terrain-hole-walk', kind: 'scene', topics: ['terrain'] },
  { id: 'explosion-blast', kind: 'scene', topics: ['explosion', 'particles', 'localVolumes'] },
  { id: 'look-pick', kind: 'look' },
  { id: 'look-metal', kind: 'look' },
  { id: 'look-fog', kind: 'look' },
  { id: 'ask-user-pin', kind: 'look', topics: ['askUser'] },
  { id: 'ask-user-pin-shared', kind: 'look', topics: ['askUser'] },
  { id: 'ask-user-lasso', kind: 'look', topics: ['askUser'] },
  { id: 'render-pick', kind: 'light' },
  { id: 'light-pick-hard', kind: 'light' },
  { id: 'light-key-fill', kind: 'light' },
  { id: 'light-spot-shadow', kind: 'light' },
  { id: 'camera-closeup', kind: 'camera' },
  { id: 'camera-orbit', kind: 'camera', topics: ['filmTimeline'] },
  { id: 'robot-shot', kind: 'camera', topics: ['motionIk', 'placedAssets'] },
  { id: 'overshoot-lift', kind: 'animation' },
  { id: 'robot-walk-wave', kind: 'animation', topics: ['placedAssets'] },
  { id: 'sunset-timelapse', kind: 'film', topics: ['filmTimeline'] },
  { id: 'film-reveal', kind: 'film', topics: ['filmTimeline'] },
];

// Tasks that scenes.mjs defines but the default run leaves out (findings-fix tests the findings channel, not a tool schema).
// `--tasks` accepts them by id; `--kinds`, `--topics` and the default run stay on BENCH_TASKS.
export const OPTIONAL_TASK_IDS = SCENE_TASKS.map(task => task.id).filter(id => !BENCH_TASKS.some(task => task.id === id));

export const SMOKE_TASKS = ['bolt', 'camera-closeup'];

export const kindOf = Object.fromEntries(BENCH_TASKS.map(task => [task.id, task.kind]));

// The reference files of skills/build-crucible-scene that an agent reads for a kind of task, following the "Pick the recipe" table
// of SKILL.md. The bench agent has no file tools, so skill mode `references` puts SKILL.md plus these files in its system prompt
// (skill-prompt.mjs). errors-and-recovery.md is in every list because any task can hit a failed call.
export const KIND_REFERENCES = {
  modeling: ['mesh-modeling.md', 'errors-and-recovery.md'],
  revision: ['mesh-modeling.md', 'errors-and-recovery.md'],
  scene: ['mesh-modeling.md', 'errors-and-recovery.md'],
  look: ['look.md', 'errors-and-recovery.md'],
  light: ['light.md', 'errors-and-recovery.md'],
  camera: ['camera.md', 'errors-and-recovery.md'],
  animation: ['film-and-animation.md', 'errors-and-recovery.md'],
  film: ['film-and-animation.md', 'camera.md', 'errors-and-recovery.md'],
};

// A task tagged with one of these topics also gets the file that covers it.
export const TOPIC_REFERENCES = {
  placedAssets: ['game.md'],
  motionIk: ['film-and-animation.md'],
  explosion: ['effects-and-feedback.md'],
  askUser: ['effects-and-feedback.md'],
};

// Reference files no bench task loads, each with the reason. A new file under references/ must be reachable from a kind or listed here.
export const NOT_LOADED_REFERENCES = {
  'scene-contract.md': 'scene code against the npm library, not MCP; the bench agent only has the scene_* tools',
};

/** The reference file names a task's prompt carries in skill mode `references`, in a stable order without repeats. */
export function referencesForTask(task) {
  const names = [...(KIND_REFERENCES[task.kind] ?? []), ...(task.topics ?? []).flatMap(topic => TOPIC_REFERENCES[topic] ?? [])];
  return [...new Set(names)];
}

/** The kinds whose prompts carry a reference file, for mapping a changed skill file to the tasks that can feel it. */
export function kindsLoadingReference(fileName) {
  const fromKinds = Object.keys(KIND_REFERENCES).filter(kind => KIND_REFERENCES[kind].includes(fileName));
  const topics = Object.keys(TOPIC_REFERENCES).filter(topic => TOPIC_REFERENCES[topic].includes(fileName));
  const fromTopics = BENCH_TASKS.filter(task => (task.topics ?? []).some(topic => topics.includes(topic))).map(task => task.kind);
  return [...new Set([...fromKinds, ...fromTopics])];
}
