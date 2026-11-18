// Builds the argument list of one `claude -p` bench run. The skill prompt goes in a file, not inline: SKILL.md plus its
// reference files run past Windows' 32,767-character command-line limit, and spawn fails with ENAMETOOLONG (#1939).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SKILL_PROMPT_FILE = 'skill-prompt.md';

export async function writeSkillPromptFile(workingDirectory, skillPrompt) {
  if (!skillPrompt) return null;
  const skillPromptPath = join(workingDirectory, SKILL_PROMPT_FILE);
  await writeFile(skillPromptPath, skillPrompt);
  return skillPromptPath;
}

export function claudeArguments({ prompt, model, configPath, serverName, builtInTools, skillPromptPath }) {
  return [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', configPath, '--strict-mcp-config',
    '--allowedTools', `mcp__${serverName}`,
    '--disallowedTools', ...builtInTools,
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--no-session-persistence',
    ...(skillPromptPath ? ['--append-system-prompt-file', skillPromptPath] : []),
  ];
}
