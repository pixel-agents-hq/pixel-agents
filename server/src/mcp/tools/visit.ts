import { z } from 'zod';

import { type Facing, FACINGS } from '../../../../core/src/layout/index.js';
import { defineTool, ok, refuse } from '../tool.js';

const facing = z.enum(FACINGS as [Facing, ...Facing[]]);

export const visit = defineTool({
  name: 'visit',
  title: 'Visit a spot',
  description:
    "Send your character (or another agent's, by `agent_id`) on a visit: it walks to a tile and " +
    'faces the way you say (`to: {col, row, facing}`), or to the free spot beside a piece of ' +
    'furniture, facing it (`to: {furniture_uid}`; get_layout lists uids). It lingers there a while, ' +
    'then wanders as usual; with `stay: true` it waits there until its agent starts its next turn. ' +
    "An agent's next turn always sends its character back to its seat. The tile must be in the grid, " +
    "walkable, not another visit's, and reachable from the agent's seat. Returns the tile and facing " +
    'the visit resolved to. Another agent can be sent only while it is not working. Sub-agents ' +
    'have no character of their own to send.',
  input: {
    agent_id: z
      .number()
      .int()
      .optional()
      .describe('The agent whose character goes; defaults to you.'),
    to: z
      .union([
        z
          .object({
            col: z.number().int(),
            row: z.number().int(),
            facing,
          })
          .strict(),
        z.object({ furniture_uid: z.string().min(1) }).strict(),
      ])
      .describe('A tile and the way to face there, or a piece of furniture by uid.'),
    stay: z
      .boolean()
      .optional()
      .describe("Wait there until the agent's next turn instead of wandering off after a while."),
  },
  changes: true,
  uses: ['agents', 'visits'],
  run: (args, { caller, office, target }) => {
    const agentId = target(args.agent_id);
    if (!office.agents.hasAgent(agentId)) {
      return refuse(
        `No agent ${agentId} in the office (sub-agents are not agents and can't be sent); list_agents shows the ids.`,
      );
    }
    const to =
      'furniture_uid' in args.to
        ? { furnitureUid: args.to.furniture_uid }
        : { tile: { col: args.to.col, row: args.to.row }, facing: args.to.facing };
    const outcome = office.visits.visit(agentId, to, { stay: args.stay === true, caller });
    if (!outcome.ok) return refuse(outcome.reason);
    const { spot, stay } = outcome;
    return ok({
      agent_id: agentId,
      tile: { col: spot.col, row: spot.row },
      facing: spot.facing,
      stay,
    });
  },
});
