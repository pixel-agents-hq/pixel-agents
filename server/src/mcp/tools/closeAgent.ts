import { z } from 'zod';

import { defineTool, ok, refuse } from '../tool.js';

export const closeAgent = defineTool({
  name: 'close_agent',
  title: 'Close agent',
  description:
    "Close a main agent (`agent_id`; defaults to you), as its card's × does, so finished work leaves " +
    'the office. Its Teammates close with it. An agent in a terminal of the office has that terminal ' +
    'ended (its CLI stops); an adopted or headless one (no terminal of ours) only leaves the office, ' +
    'its session running on where it was started. Closing yourself is allowed: the reply comes first, ' +
    'then your session ends as soon as your turn does, so make it your last call. Teammates are refused ' +
    '(close their lead), and Sub-agents are not agents of their own. When the agent would leave a ' +
    'Worktree of ours with uncommitted files, nothing is closed and the error says how many: ask the ' +
    'user, then call again with `worktree_choice` — "save" (commit them to the branch), "keep" (leave ' +
    'the folder as it is) or "discard" with `confirmed_files` set to that count. A discard is refused ' +
    'again when the Worktree has more files by then.',
  input: {
    agent_id: z.number().int().optional().describe('The agent to close; defaults to you.'),
    worktree_choice: z
      .enum(['save', 'keep', 'discard'])
      .optional()
      .describe("What to do with its Worktree's uncommitted files (only when asked)."),
    confirmed_files: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('For a discard: the uncommitted file count the user agreed to lose.'),
  },
  changes: true,
  uses: ['close'],
  run: async (args, { caller, office, target }) => {
    const outcome = await office.close.closeAgent({
      id: target(args.agent_id),
      caller,
      worktreeChoice: args.worktree_choice,
      confirmedFiles: args.confirmed_files,
    });
    if (!outcome.ok) return refuse(outcome.reason);
    return ok({
      agent_id: outcome.id,
      closed: true,
      how:
        outcome.how === 'ended'
          ? 'its terminal was ended'
          : 'it left the office; its session runs on outside it',
      ...(outcome.afterReply ? { you: true, closes_after_reply: true } : {}),
      ...(outcome.teammates.length > 0 ? { teammates_closed: outcome.teammates } : {}),
      ...(outcome.worktree ? { worktree: outcome.worktree } : {}),
    });
  },
});
