// The skill text a bench run puts in the agent's system prompt, by skill mode (bench.mjs and run.mjs --skill-mode):
//   none        no skill (the default, and what the stored bench-baseline.json was measured with)
//   legacy      SKILL.md and references/mesh-modeling.md for every task (what --skill did before skill modes)
//   references  SKILL.md and the reference files the task's kind and topics point to (suite.mjs KIND_REFERENCES), so an edit
//               to light.md reaches the prompt of a light task. This is the mode for a change under skills/.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BENCH_TASKS, referencesForTask } from './suite.mjs';

export const SKILL_MODES = Object.freeze(['none', 'legacy', 'references']);

const SKILL_DIRECTORY = ['skills', 'build-crucible-scene'];

/** The skill mode a run is in; `--skill` alone keeps meaning `legacy`. Throws for a mode that does not exist. */
export function resolveSkillMode({ skillMode, skill }) {
  if (skillMode === undefined) return skill ? 'legacy' : 'none';
  if (!SKILL_MODES.includes(skillMode)) throw new RangeError(`--skill-mode must be one of ${SKILL_MODES.join(', ')}, got "${skillMode}". Use "references" to bench a change under skills/.`);
  if (skill && skillMode !== 'legacy') throw new RangeError(`--skill means --skill-mode legacy and conflicts with --skill-mode ${skillMode}. Pass only --skill-mode.`);
  return skillMode;
}

/** The text to append to the system prompt for one task, or null when the mode loads no skill. A task outside BENCH_TASKS gets SKILL.md alone in `references` mode. */
export async function skillPromptFor(mode, task, repository) {
  if (mode === 'none') return null;
  const directory = join(repository, ...SKILL_DIRECTORY);
  const fileNames = mode === 'legacy' ? ['mesh-modeling.md'] : referencesForTask(BENCH_TASKS.find(candidate => candidate.id === task.id) ?? { kind: null });
  const entryPoint = await readFile(join(directory, 'SKILL.md'), 'utf8');
  const references = await Promise.all(fileNames.map(name => readFile(join(directory, 'references', name), 'utf8')));
  return [entryPoint, ...references].join('\n\n');
}
