import { useEffect, useState } from 'react';

import {
  CASCADE_INDENT_PX,
  CASCADE_PANEL_BOTTOM_PX,
  CASCADE_PANEL_MARGIN_PX,
  CASCADE_PANEL_REFRESH_MS,
  CASCADE_PANEL_TOP_PX,
  CASCADE_PANEL_WIDTH_PX,
  CASCADE_PANEL_Z_INDEX,
  CASCADE_SHEET_MAX_HEIGHT,
  CASCADE_STATUS_DOT_PX,
  TERMINAL_SIDEBAR_WIDTH_PX,
  TIER_BADGE_SWATCH_PX,
} from '../constants.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { formatTokens, TIER_COLORS } from '../office/modelTier.js';
import type { ToolActivity } from '../office/types.js';
import {
  buildCascadeRows,
  type CascadeCharacter,
  type CascadeStatus,
  cascadeTierTotals,
} from './cascadeTree.js';

interface CascadePanelProps {
  officeState: OfficeState;
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  /** Phone layout: a bottom sheet instead of a right-hand panel. */
  isMobile: boolean;
  /** Desktop: the agent card bar is drawn over the office's right edge, so the
   *  panel sits to its left; without cards it can sit at the edge. */
  cardBarShown: boolean;
  /** Row click: select the character and make the camera follow it. */
  onSelect: (id: number) => void;
}

const STATUS_DOT: Record<CascadeStatus, string> = {
  active: 'bg-status-active',
  waiting: 'bg-status-success',
  permission: 'bg-status-permission',
  idle: 'bg-text-muted',
};

const STATUS_LABEL: Record<CascadeStatus, string> = {
  active: 'Active',
  waiting: 'Waiting',
  permission: 'Needs permission',
  idle: 'Idle',
};

/**
 * The cascade as a tree: every agent with its sub-agents under it, tier
 * swatch, badge, status and token spend, plus tokens per tier on top. Mount it
 * only while open: the office state is imperative, so while mounted it polls it
 * (about 4 Hz) to re-render, and when closed nothing runs.
 */
export function CascadePanel({
  officeState,
  agentTools,
  subagentTools,
  subagentCharacters,
  isMobile,
  cardBarShown,
  onSelect,
}: CascadePanelProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), CASCADE_PANEL_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const characters: CascadeCharacter[] = [...officeState.characters.values()];
  const toolsFor = (c: CascadeCharacter): ToolActivity[] | undefined => {
    if (!c.isSubagent) return agentTools[c.id];
    const sub = subagentCharacters.find((s) => s.id === c.id);
    return sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
  };
  const rows = buildCascadeRows(characters, toolsFor);
  const totals = cascadeTierTotals(characters);
  const selectedId = officeState.selectedAgentId;

  const rightPx = (cardBarShown ? TERMINAL_SIDEBAR_WIDTH_PX : 0) + CASCADE_PANEL_MARGIN_PX;
  const placement = isMobile
    ? {
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: CASCADE_SHEET_MAX_HEIGHT,
      }
    : {
        top: CASCADE_PANEL_TOP_PX,
        bottom: CASCADE_PANEL_BOTTOM_PX,
        right: rightPx,
        width: CASCADE_PANEL_WIDTH_PX,
        // A narrow office (VS Code side panel) shrinks the panel, margin kept on both sides.
        maxWidth: `calc(100% - ${rightPx + CASCADE_PANEL_MARGIN_PX}px)`,
      };

  return (
    <div
      className="pixel-panel absolute flex flex-col min-h-0 overflow-hidden"
      style={{ ...placement, zIndex: CASCADE_PANEL_Z_INDEX }}
      data-testid="cascade-panel"
      role="region"
      aria-label="Cascade"
    >
      <div className="shrink-0 px-8 py-4 border-b-2 border-border flex flex-wrap gap-x-8 gap-y-1 text-sm">
        {totals.length === 0 ? (
          <span className="text-text-muted">No token spend yet</span>
        ) : (
          totals.map((t) => (
            <span key={t.tier} className="flex items-center gap-3 whitespace-nowrap">
              <span
                aria-hidden="true"
                className="shrink-0"
                style={{
                  width: TIER_BADGE_SWATCH_PX,
                  height: TIER_BADGE_SWATCH_PX,
                  background: TIER_COLORS[t.tier],
                }}
              />
              {t.label} {formatTokens(t.tokens)}
            </span>
          ))
        )}
      </div>
      <div className="min-h-0 overflow-y-auto overflow-x-hidden">
        {rows.length === 0 && <div className="px-8 py-6 text-sm text-text-muted">No agents</div>}
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onSelect(row.id)}
            aria-current={selectedId === row.id ? 'true' : undefined}
            title={`${row.name} · ${STATUS_LABEL[row.status]}`}
            className={`block w-full text-left cursor-pointer border-0 border-b border-border py-3 pr-8 text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-bright ${
              selectedId === row.id ? 'bg-active-bg' : 'bg-transparent hover:bg-btn-hover'
            }`}
            style={{ paddingLeft: 8 + row.depth * CASCADE_INDENT_PX }}
          >
            <span className="flex items-center gap-4 min-w-0">
              <span
                aria-hidden="true"
                className="shrink-0"
                style={{
                  width: TIER_BADGE_SWATCH_PX,
                  height: TIER_BADGE_SWATCH_PX,
                  background: TIER_COLORS[row.tier],
                }}
              />
              <span
                role="img"
                aria-label={STATUS_LABEL[row.status]}
                className={`shrink-0 rounded-full ${STATUS_DOT[row.status]} ${
                  row.status === 'active' ? 'pixel-pulse' : ''
                }`}
                style={{ width: CASCADE_STATUS_DOT_PX, height: CASCADE_STATUS_DOT_PX }}
              />
              <span className="min-w-0 flex-1 truncate">
                {row.parentName && <span className="sr-only">Sub-agent of {row.parentName}: </span>}
                {row.name}
              </span>
              <span className="shrink-0 text-sm text-text-muted">
                {row.tokens > 0 ? formatTokens(row.tokens) : ''}
              </span>
            </span>
            {row.badge && (
              <span className="block truncate text-sm text-text-muted">{row.badge}</span>
            )}
            <span className="block truncate text-sm">{row.statusLine}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
