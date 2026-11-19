import { z } from 'zod';

import { noAgentReason } from '../officeOperations.js';
import { defineTool, ok, refuse } from '../tool.js';

export const readAgentTerminal = defineTool({
  name: 'read_agent_terminal',
  title: 'Read agent terminal',
  description:
    "Read an agent's terminal screen as text (the rows it shows right now), with its status and a " +
    '`screen_token`. Read before you message an agent: send_message checks the token and refuses ' +
    'if the screen changed since, so you never answer a prompt you did not see. Agents without a ' +
    'terminal of this office (headless, adopted) give their status only, and so does every agent in ' +
    "an office whose terminals can't be read (VS Code). Defaults to your own terminal.",
  input: {
    agent_id: z.number().int().optional().describe('The agent to read (default: you).'),
  },
  changes: false,
  uses: ['agents', 'messaging'],
  run: async ({ agent_id }, { office, target }) => {
    const id = target(agent_id);
    if (!office.agents.hasAgent(id)) return refuse(noAgentReason(id));
    const read = await office.messaging.readAgentTerminal(id);
    if (!read.screen) return ok({ agent_id: id, status: read.status, no_screen: read.noScreen });
    return ok({
      agent_id: id,
      status: read.status,
      screen: read.screen.text,
      screen_token: read.screen.token,
    });
  },
});
