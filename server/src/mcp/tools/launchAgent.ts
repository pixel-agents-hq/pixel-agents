import { z } from 'zod';

import { LAUNCH_JOIN_TIMEOUT_MS, NICKNAME_MAX_LENGTH } from '../../constants.js';
import { defineTool, ok, refuse } from '../tool.js';

export const launchAgent = defineTool({
  name: 'launch_agent',
  title: 'Launch agent',
  description:
    "Launch a new agent into a Directory, as the office's launch drawer does (its default characters, " +
    'Areas and Worktree rules apply), or resume a past conversation as the conversation list does. ' +
    'Give only the options the user asked for. `directory` is a Directory name (list_agents and ' +
    'get_layout show them) or an absolute folder path. `first_message` is sent as its first prompt, so ' +
    'it starts working at once. `character` is a character id, exact name or palette index (list_characters ' +
    'shows them); `seat` a seat id from get_layout, taken when free (else the office picks one, and `notes` ' +
    `says so). \`nickname\` (at most ${NICKNAME_MAX_LENGTH} characters) labels it "Directory · nickname · ` +
    'worktree" on its card and over its character; it is only a label. `worktree` launches it into a new ' +
    'Worktree of the Directory (`name`, and `from`: the branch to start from, `origin/<name>` for ' +
    "origin's). `resume_session_id` brings back a past conversation of the Directory (where it ran, " +
    'its own Worktree included). `model` and `permission_mode` go to the CLI; without a ' +
    "`permission_mode` the office's own setting applies. bypassPermissions is refused unless the user " +
    'allowed skipping permissions in Settings. Returns once the agent has joined (its CLI is running) ' +
    `with its id, seat (null until an office seats it), character and session id; fails after about ${Math.round(LAUNCH_JOIN_TIMEOUT_MS / 1000)} s.`,
  input: {
    directory: z.string().min(1).describe('A Directory name, or an absolute folder path.'),
    first_message: z.string().min(1).optional().describe('Its first prompt.'),
    character: z
      .union([z.string().min(1), z.number().int()])
      .optional()
      .describe('A character id, exact name or palette index.'),
    seat: z.string().min(1).optional().describe('A seat id (get_layout).'),
    nickname: z.string().optional().describe('A short label shown after its Directory.'),
    worktree: z
      .object({
        name: z.string().min(1).optional().describe('The Worktree name (absent = generated).'),
        from: z
          .string()
          .min(1)
          .optional()
          .describe("The branch it starts from (absent = the Directory's base)."),
      })
      .optional()
      .describe('Launch into a new Worktree of the Directory.'),
    resume_session_id: z
      .string()
      .min(1)
      .optional()
      .describe('Resume this past conversation (a session id) instead of starting a new one.'),
    model: z.string().min(1).optional().describe('The model to run (an id or alias).'),
    permission_mode: z
      .string()
      .min(1)
      .optional()
      .describe('A permission mode of the CLI (e.g. default, acceptEdits, plan).'),
  },
  changes: true,
  uses: ['launch'],
  run: async (args, { office }) => {
    const result = await office.launch.launchAgent({
      directory: args.directory,
      character: args.character,
      seat: args.seat,
      worktree: args.worktree,
      resumeSessionId: args.resume_session_id,
      asks: {
        nickname: args.nickname,
        firstMessage: args.first_message,
        model: args.model,
        permissionMode: args.permission_mode,
      },
    });
    if (!result.ok) return refuse(result.reason);
    return ok({
      agent_id: result.id,
      seat: result.seat,
      character: result.character,
      session_id: result.session,
      ...(result.notes.length > 0 ? { notes: result.notes } : {}),
    });
  },
});
