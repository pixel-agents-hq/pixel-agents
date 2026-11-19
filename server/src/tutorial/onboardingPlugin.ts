/**
 * The onboarding skill on disk, for the Guide's session alone: written under
 * ~/.pixel-agents/tutorial-plugin/ on every start from tutorialCopy.ts, so the
 * skill is always this build's. What is written there (the folder layout, the
 * files' format) is the provider's packaging (`HookProvider.skills`; Claude
 * Code's is a plugin folder holding one skill).
 */

import * as os from 'os';
import * as path from 'path';

import type { SkillPackaging } from '../../../core/src/provider.js';
import { PIXEL_AGENTS_DIR } from '../constants.js';
import {
  TUTORIAL_PLUGIN_DESCRIPTION,
  TUTORIAL_PLUGIN_NAME,
  TUTORIAL_SKILL_ID,
  TUTORIAL_SKILL_TITLE,
  tutorialBrief,
  tutorialSkillDescription,
} from './tutorialCopy.js';

const PLUGIN_FOLDER = 'tutorial-plugin';

/** Write the skill and return the folder its launch names. Throws when it can't be written. */
export function writeOnboardingPlugin(
  skills: SkillPackaging,
  guideName: string,
  home: string = os.homedir(),
): string {
  return skills.write(path.join(home, PIXEL_AGENTS_DIR, PLUGIN_FOLDER), {
    plugin: TUTORIAL_PLUGIN_NAME,
    pluginDescription: TUTORIAL_PLUGIN_DESCRIPTION,
    id: TUTORIAL_SKILL_ID,
    description: tutorialSkillDescription(guideName),
    title: TUTORIAL_SKILL_TITLE,
    instructions: tutorialBrief(guideName),
  });
}
