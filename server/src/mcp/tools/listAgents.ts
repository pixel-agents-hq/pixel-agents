import type { OfficeAgent } from '../officeOperations.js';
import { defineTool, ok } from '../tool.js';

/** One agent as the tool reports it (snake_case, the agent-facing shape). */
function describeAgent(agent: OfficeAgent, caller: number): Record<string, unknown> {
  return {
    id: agent.id,
    ...(agent.id === caller ? { you: true } : {}),
    directory: agent.directory,
    working_directory: agent.workingDirectory,
    worktree: agent.worktree,
    status: agent.status,
    activity: agent.activity,
    subagents_running: agent.subagentsRunning,
    context: agent.context && {
      left_share: agent.context.leftShare,
      used_tokens: agent.context.usedTokens,
      window_tokens: agent.context.windowTokens,
    },
    conversation_title: agent.conversationTitle,
    transcript_path: agent.transcriptPath,
    lead_id: agent.leadId,
    teammates: agent.teammates,
    seat: agent.seat,
    character: agent.character,
  };
}

export const listAgents = defineTool({
  name: 'list_agents',
  title: 'List agents',
  description:
    'List every agent in the Pixel Agents office (you included, marked `you: true`): id, ' +
    'Directory and working directory, Worktree, status (active / done / waiting for input / ' +
    'permission request), current activity, sub-agents running, context left, conversation title, ' +
    'transcript path, lead and teammates, seat (with its tile and Area) and character.',
  input: {},
  changes: false,
  uses: ['agents'],
  run: (_args, { caller, office }) => {
    const agents = office.agents.listAgents().map((agent) => describeAgent(agent, caller));
    return ok({ agents });
  },
});
