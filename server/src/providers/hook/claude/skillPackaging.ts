/**
 * A skill as Claude Code loads it for one session: a plugin folder passed
 * with `--plugin-dir` (nothing written to ~/.claude).
 *
 *   <dir>/
 *     .claude-plugin/plugin.json   { name, description }
 *     skills/<id>/SKILL.md         frontmatter (name, description) + the instructions
 *
 * Claude Code names the skill `<plugin>:<id>` and runs it as the slash
 * command `/<plugin>:<id>`.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { SkillPackaging } from '../../../../../core/src/provider.js';

/** A skill's SKILL.md: its frontmatter, a title and the instructions. */
export function skillMarkdown(skill: {
  id: string;
  description: string;
  title: string;
  instructions: string;
}): string {
  return [
    '---',
    `name: ${skill.id}`,
    `description: ${skill.description}`,
    '---',
    '',
    `# ${skill.title}`,
    '',
    skill.instructions,
    '',
  ].join('\n');
}

export const claudeSkillPackaging: SkillPackaging = {
  command: (plugin, id) => `/${plugin}:${id}`,
  skillName: (plugin, id) => `${plugin}:${id}`,
  write(dir, skill) {
    const manifestDir = path.join(dir, '.claude-plugin');
    const skillDir = path.join(dir, 'skills', skill.id);
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      `${JSON.stringify({ name: skill.plugin, description: skill.pluginDescription }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMarkdown(skill));
    return dir;
  },
};
