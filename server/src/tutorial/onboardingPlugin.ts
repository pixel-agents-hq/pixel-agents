/**
 * The onboarding skill on disk: a plugin folder Claude Code loads for the
 * Guide's session alone (`--plugin-dir`, nothing written to
 * ~/.claude). Rewritten on every start from tutorialCopy.ts, so the skill is
 * always this build's.
 *
 *   ~/.pixel-agents/tutorial-plugin/
 *     .claude-plugin/plugin.json   { name: "pixel-agents" }
 *     skills/onboarding/SKILL.md
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PIXEL_AGENTS_DIR } from '../constants.js';
import { TUTORIAL_PLUGIN_NAME, TUTORIAL_SKILL_DIR, tutorialSkillMarkdown } from './tutorialCopy.js';

const PLUGIN_FOLDER = 'tutorial-plugin';

/** Write the plugin and return its folder. Throws when it can't be written. */
export function writeOnboardingPlugin(guideName: string, home: string = os.homedir()): string {
  const root = path.join(home, PIXEL_AGENTS_DIR, PLUGIN_FOLDER);
  const manifestDir = path.join(root, '.claude-plugin');
  const skillDir = path.join(root, 'skills', TUTORIAL_SKILL_DIR);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    `${JSON.stringify({ name: TUTORIAL_PLUGIN_NAME, description: 'The Pixel Agents tutorial' }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), tutorialSkillMarkdown(guideName));
  return root;
}
