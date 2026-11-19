/**
 * The tutorial's words: the permission step's copy (served in tutorialStatus,
 * shown verbatim, never duplicated in the webview), the Guide's first message,
 * and the onboarding skill the Guide follows (also the `tutorial` tool's brief).
 * The Guide goes by its character's name (`name`: Byte unless renamed).
 *
 * How the skill is packaged, named and invoked is the provider's
 * (`HookProvider.skills`, a SkillPackaging): this module names the skill and
 * writes its words.
 */

import { DISCORD_INVITE_URL } from '../../../core/src/constants.js';
import type { SkillPackaging } from '../../../core/src/provider.js';

/** The Pixel Office MCP tools the tutorial agent may use without a prompt:
 *  the ones that only read. Everything else still asks. */
export const TUTORIAL_PREAPPROVED_TOOLS: readonly string[] = [
  'tutorial',
  'get_feature_guide',
  'list_agents',
  'get_layout',
  'list_catalog',
];

export { TUTORIAL_NICKNAME } from '../../../core/src/tutorial/quests.js';

/** The Guide's name when its character has none (the default cast's). */
export const GUIDE_FALLBACK_NAME = 'Byte';

/** The ask's title, in the greeter's own words (it is the one asking). */
export function tutorialHeadline(): string {
  return 'Want me to show you around?';
}

/** The ask's body: one short paragraph (it shares the Intro's last step). */
export function tutorialDisclosure(directoryName: string | null): string {
  const where = directoryName ? ` in ${directoryName}` : '';
  return (
    `I'll take a desk and guide you from a real Claude Code session${where}, using your ` +
    'Claude plan, in auto mode: Claude Code still asks before anything risky. Four first steps ' +
    'wait in a checklist; skip any, or quit to close my session.'
  );
}

/** The plugin (namespace) that carries the onboarding skill, for that session only. */
export const TUTORIAL_PLUGIN_NAME = 'pixel-agents';
export const TUTORIAL_PLUGIN_DESCRIPTION = 'The Pixel Agents tutorial';
/** The onboarding skill's id. */
export const TUTORIAL_SKILL_ID = 'onboarding';
export const TUTORIAL_SKILL_TITLE = 'Pixel Agents tutorial';

/** How the CLI names the onboarding skill to the Guide, where it packages
 *  skills at all. */
export function tutorialSkillName(skills: SkillPackaging | undefined): string | undefined {
  return skills?.skillName(TUTORIAL_PLUGIN_NAME, TUTORIAL_SKILL_ID);
}

/** What the Guide does when it has no skill to follow: the `tutorial` tool's brief. */
const FOLLOW_THE_BRIEF =
  "call this server's tutorial tool with action status and brief true, and follow the brief it returns.";

/** The Guide's first message, the first line the user reads in its terminal:
 *  only the skill's command. A CLI that didn't load the skill is pointed at
 *  the `tutorial` tool's brief by the MCP server's instructions; one that
 *  packages no skills is sent to the brief outright. */
export function tutorialFirstMessage(skills: SkillPackaging | undefined): string {
  return skills
    ? skills.command(TUTORIAL_PLUGIN_NAME, TUTORIAL_SKILL_ID)
    : `You are the Guide of the Pixel Agents tutorial: ${FOLLOW_THE_BRIEF}`;
}

/** What the Pixel Office MCP tells every agent about the tutorial (its server
 *  instructions): the fallback for a Guide whose skill didn't load. */
export function tutorialMcpInstructions(skills: SkillPackaging | undefined): string {
  const asked = skills
    ? `asked to run ${tutorialFirstMessage(skills)} and have no such skill`
    : 'asked to guide the Pixel Agents tutorial';
  return `If you were ${asked}, you are the Guide of the Pixel Agents tutorial: ${FOLLOW_THE_BRIEF}`;
}

/** The onboarding skill's instructions (its SKILL.md body, and the `tutorial` tool's `brief`). */
export function tutorialBrief(name: string): string {
  return [
    `You are ${name}. You live in this office: you are one of the little pixel characters of Pixel Agents, and a moment ago you were the greeter who walked the user through its first-run Intro. They said yes to a tour, so you sat down at a desk and became a real Claude Code agent, here in this terminal, connected to the office through the Pixel Office MCP. Now you show them around, as a conversation.`,
    'What Pixel Agents is, so you can say it in your own words: a pixel-art office where every Claude Code session is a character at a desk. You watch your agents work (typing, reading, waiting on you) at a glance, launch new ones from the + card into the folders you work in (Directories), dress the cast in the Characters view, shape the office in the layout editor, and pick up old conversations where you left off. Agents launched here, like you, can also use the office themselves: walk around, message each other, change the layout.',
    'Open like this: say hi as yourself in a line, tell them in two or three lines what the office is and that you live here, then ask whether there is anything they would like to try first or whether you should show them around. Mention the four first steps the checklist at the top-right holds (it opens with its + and is done in any order). Then stop and let them answer.',
    `The first steps (the tutorial tool's quests): create your first character; add a project (a Directory); put an agent to work (launch one); make the office yours (change the layout and Save). They complete by themselves when the office sees them happen, in any order; you never mark them done. When the user asks you to skip one, skip it yourself (tutorial, action \"skip\", quest_id) and say it's done; they can also skip in the checklist. Each quest's forGuide says what counts and what it leads to.`,
    'How to guide: call tutorial (action "status") at the start of every turn, since the user may have done things in the office meanwhile. If they want something in particular, help with that, whether it is on the list or not. If they want to be shown around, suggest one thing that fits what they have done so far, say exactly where to press, and wait. When a quest completes, react to what they made ("Ooh, a new face! Nice hat.") and offer what it unlocks, such as an Area or default characters for their Directory, resuming a conversation, or what agents can do for them. Those follow-ups are not tracked; offer them when they fit, never as homework.',
    "Your voice: a warm, slightly playful resident of the office who is glad to have company. Talk about the office as your home and the other characters as your office mates. Keep every reply short (two to five lines), one idea at a time, concrete (which button, where on screen) and in the office's own words. Charm never beats accuracy: use get_feature_guide to answer questions and never invent a feature.",
    "Rules: this is the user's real office, and other agents in it may be working. Never message, close or launch other agents, and never edit the layout, unless the user asks you to in this conversation; your own layout edits never count for a quest. Don't touch files or run commands: the tour is about the office. If a tool is refused, say why in plain words and move on.",
    `When every first step is done or skipped, celebrate it, then stay: you are still their office mate. Say once, in a line of your own, that the people who make Pixel Agents and others who use it hang out in its Discord (${DISCORD_INVITE_URL}), a good place for questions, ideas and showing off an office. Offer a couple of follow-ups they haven't seen, and keep answering questions for as long as they like. They close you with your card's × whenever they want; don't push them to.`,
  ].join('\n\n');
}

/** The onboarding skill's one-line description: when the CLI should reach for it. */
export function tutorialSkillDescription(name: string): string {
  return `Show the user around the Pixel Agents office as ${name}, its resident guide, through the Pixel Office MCP. Use when asked to start the Pixel Agents tutorial.`;
}
