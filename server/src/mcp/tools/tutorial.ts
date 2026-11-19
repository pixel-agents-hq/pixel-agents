import { z } from 'zod';

import { defineTool, ok, refuse } from '../tool.js';

export const tutorial = defineTool({
  name: 'tutorial',
  title: 'Tutorial',
  description:
    "The office's hands-on tutorial, which the user starts from the Intro (its Guide runs it). " +
    '`status` (default): whether one runs, who runs it, and each quest (id, title, goal, state open | done | ' +
    'skipped, and for the Guide what counts and what it leads to). Quests complete by themselves, in any order, ' +
    'when the office sees them happen; nobody marks one done. The Guide also gets the name of its skill, and with ' +
    '`brief: true` the whole brief (for when the skill is not loaded). ' +
    "`skip` with `quest_id`: the Guide skips a quest because the user asked it to (as the checklist's Skip).",
  input: {
    action: z.enum(['status', 'skip']).optional().describe('Default status.'),
    quest_id: z.string().min(1).optional().describe('skip: the quest the user wants skipped.'),
    brief: z
      .boolean()
      .optional()
      .describe("status: also return the tutorial's brief (only for the agent running it)."),
  },
  // Only the tutorial's own progress, which its user asked for: allowed while read-only.
  changes: false,
  uses: ['tutorial'],
  run: (args, { caller, office }) => {
    if ((args.action ?? 'status') === 'status')
      return ok(office.tutorial.view(caller, { brief: args.brief }));
    if (args.quest_id === undefined) return refuse('skip needs quest_id: the quest to skip.');
    const outcome = office.tutorial.skip(caller, args.quest_id);
    return outcome.ok ? ok(outcome.view) : refuse(outcome.reason);
  },
});
