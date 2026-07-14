import type { ActivityEntry } from '../../../core/src/messages.js';
import { AGENT_TYPE_BADGE_FALLBACK, AGENT_TYPE_COLORS } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';

interface AgentDetailPanelProps {
  selectedAgentId: number | null;
  agents: number[];
  agentActivity: Record<number, ActivityEntry[]>;
  agentStatuses: Record<number, string>;
  officeState: OfficeState;
  height: number;
  onSelectAgent: (id: number) => void;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/**
 * Bottom detail panel for the standalone browser dashboard. With no agent
 * selected it lists all agents (click to focus + follow); with one selected it
 * shows a header (folder, status, tokens) and a reverse-chronological activity
 * feed. Colors/fonts come from the shared pixel-art theme tokens.
 */
export function AgentDetailPanel({
  selectedAgentId,
  agents,
  agentActivity,
  agentStatuses,
  officeState,
  height,
  onSelectAgent,
}: AgentDetailPanelProps) {
  const selectedCh =
    selectedAgentId !== null ? officeState.characters.get(selectedAgentId) : undefined;
  const showDetail = selectedAgentId !== null && !!selectedCh;

  return (
    <div
      data-testid="agent-detail-panel"
      className="shrink-0 overflow-auto bg-bg text-text border-t-2 border-border"
      style={{ height }}
    >
      {!showDetail ? (
        <div data-testid="agent-overview">
          {agents.length === 0 ? (
            <div className="p-8 text-text-muted text-sm">No active agents.</div>
          ) : (
            agents.map((id) => {
              const ch = officeState.characters.get(id);
              const last = agentActivity[id]?.at(-1)?.label ?? '';
              return (
                <button
                  key={id}
                  data-testid="agent-overview-row"
                  data-agent-id={id}
                  onClick={() => onSelectAgent(id)}
                  className="block w-full text-left border-0 bg-bg text-text p-8 cursor-pointer font-pixel"
                  style={{ borderBottom: '2px solid var(--color-border)' }}
                >
                  <span className="text-sm font-bold">{ch?.folderName ?? `Agent ${id}`}</span>{' '}
                  <span className="text-2xs text-text-muted">{agentStatuses[id] ?? 'active'}</span>
                  {last && <div className="text-2xs text-text-muted">{last}</div>}
                </button>
              );
            })
          )}
        </div>
      ) : (
        <div>
          <div
            data-testid="agent-detail-header"
            data-agent-id={selectedAgentId ?? undefined}
            className="p-8 border-b-2 border-border"
          >
            {selectedCh?.agentType && (
              <span
                className="text-2xs font-bold mr-4"
                style={{
                  color: AGENT_TYPE_COLORS[selectedCh.agentType] ?? AGENT_TYPE_BADGE_FALLBACK,
                }}
              >
                {selectedCh.agentType}
              </span>
            )}
            <span className="text-sm font-bold">
              {selectedCh?.folderName ?? `Agent ${selectedAgentId}`}
            </span>{' '}
            <span className="text-2xs text-text-muted">
              {agentStatuses[selectedAgentId as number] ?? 'active'}
            </span>
            <div className="text-2xs text-text-muted">
              {selectedCh ? `${selectedCh.inputTokens + selectedCh.outputTokens} tokens` : ''}
            </div>
          </div>
          <div data-testid="activity-feed">
            {(agentActivity[selectedAgentId as number] ?? [])
              .slice()
              .reverse()
              .map((e, i) => (
                <div
                  key={`${e.ts}-${i}`}
                  data-testid="activity-entry"
                  className="flex gap-8 px-8 py-2 text-2xs"
                >
                  <span className="shrink-0 text-text-muted">{fmtTime(e.ts)}</span>
                  <span className="text-text">{e.label}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
