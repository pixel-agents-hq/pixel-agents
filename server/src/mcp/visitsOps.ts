/**
 * Visits as the Pixel Office MCP sends them (visit): a target resolved and
 * checked on one office snapshot, then recorded and told to every office
 * (visits.ts). Owns following the agents' turns, so a visit ends on its
 * agent's next one.
 */

import {
  footprintTiles,
  spotBeside,
  type VisitSpot,
  visitTileProblem,
} from '../../../core/src/layout/index.js';
import { currentVisit, followTurnsForVisits, startVisit } from '../visits.js';
import { statusOf } from './agentsView.js';
import { type OfficeFacts, officeSnapshot } from './officeFacts.js';
import type { VisitOps, VisitTarget } from './officeOperations.js';

export interface VisitOpsHandle extends VisitOps {
  /** Stop following the agents' turns. */
  dispose(): void;
}

export function createVisitOps(facts: OfficeFacts): VisitOpsHandle {
  const { store } = facts;
  const turns = followTurnsForVisits(store);

  /** The tiles agents' visits hold (as `col,row`) — but `except`'s — and who holds each. */
  function visitTiles(except?: number): Map<string, number> {
    const taken = new Map<string, number>();
    for (const [id, agent] of store) {
      const visit = id === except ? undefined : currentVisit(agent);
      if (visit) taken.set(`${visit.to.col},${visit.to.row}`, id);
    }
    return taken;
  }

  function resolveVisit(
    agentId: number,
    target: VisitTarget,
  ): { ok: true; spot: VisitSpot } | { ok: false; reason: string } {
    const office = officeSnapshot(facts);
    const grid = office.grid();
    if (!office.layout || !office.catalog || !grid) {
      return {
        ok: false,
        reason: 'The office has no layout yet; open the office once, then retry.',
      };
    }
    const from = office.seatTileOf(agentId);
    const taken = visitTiles(agentId);
    if ('furnitureUid' in target) {
      const item = office.layout.furniture.find((f) => f.uid === target.furnitureUid);
      if (!item) {
        return {
          ok: false,
          reason: `No furniture with uid "${target.furnitureUid}" in the office; get_layout with detail "furniture" lists every item's uid.`,
        };
      }
      const spot = spotBeside(grid, footprintTiles(office.catalog, item), {
        from,
        taken: new Set(taken.keys()),
      });
      if (!spot) {
        return {
          ok: false,
          reason: `Nothing beside furniture "${item.uid}" is free and ${from ? `reachable from agent ${agentId}'s seat` : 'walkable'}; pick another item or a tile.`,
        };
      }
      return { ok: true, spot };
    }
    const tile = target.tile;
    const at = `(${tile.col}, ${tile.row})`;
    const { cols, rows } = office.layout;
    switch (visitTileProblem(grid, tile, from)) {
      case 'out of grid':
        return {
          ok: false,
          reason: `Tile ${at} is outside the office, which is ${cols} columns by ${rows} rows (col 0-${cols - 1}, row 0-${rows - 1}).`,
        };
      case 'not walkable':
        return {
          ok: false,
          reason: `Tile ${at} is a wall, empty space or under furniture; pick a floor tile (get_layout with detail "tiles" shows them), or visit a piece of furniture by its uid.`,
        };
      case 'unreachable':
        return {
          ok: false,
          reason: `Tile ${at} can't be reached from agent ${agentId}'s seat (walls or furniture close it off); pick a tile it can walk to.`,
        };
    }
    const holder = taken.get(`${tile.col},${tile.row}`);
    if (holder !== undefined) {
      return {
        ok: false,
        reason: `Agent ${holder}'s character is visiting tile ${at}; pick another tile.`,
      };
    }
    return { ok: true, spot: { col: tile.col, row: tile.row, facing: target.facing } };
  }

  return {
    visit(agentId, target, { stay, caller }) {
      const agent = store.get(agentId);
      if (!agent) return { ok: false, reason: `No agent ${agentId} in the office.` };
      // As the offices were last told (list_agents reads it the same way).
      const status = statusOf(agent);
      const inTurn = status === 'active' || status === 'permission request';
      if (inTurn && agentId !== caller) {
        return {
          ok: false,
          reason: `Agent ${agentId} is working, and a working agent's character stays at its desk; send it once its turn has ended (list_agents shows its status).`,
        };
      }
      const resolved = resolveVisit(agentId, target);
      if (!resolved.ok) return resolved;
      startVisit(store, agentId, resolved.spot, { stay, inTurn });
      return { ok: true, spot: resolved.spot, stay };
    },

    spotBesideAgent(agentId, visitorId) {
      if (!store.has(agentId)) return null;
      const office = officeSnapshot(facts);
      const grid = office.grid();
      const seat = office.seatTileOf(agentId);
      if (!grid || !seat) return null;
      const from = visitorId === undefined ? null : office.seatTileOf(visitorId);
      return spotBeside(grid, [seat], { from, taken: new Set(visitTiles(visitorId).keys()) });
    },

    dispose() {
      turns.dispose();
    },
  };
}
