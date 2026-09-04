import { MOBILE_TERMINAL_FONT_SIZE_PX } from '../constants.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import type { TerminalInputHandle } from './TerminalPane.js';
import { TerminalPane } from './TerminalPane.js';

interface MobileTerminalPageProps {
  /** Agent ids with a live PTY, in open order. */
  agentIds: number[];
  activeAgentId: number | null;
  onStatusChange: (agentId: number, status: TerminalConnectionStatus) => void;
  /** Passed through to each pane so the key bar can write to the active PTY. */
  onRegisterInput: (agentId: number, handle: TerminalInputHandle | null) => void;
}

/**
 * The mobile shell's terminal page — the full-screen pane the office slides
 * away to reveal. One TerminalPane per launched agent, all mounted (buffers
 * and sockets survive switches, same as the desktop drawer), only the active
 * one visible.
 *
 * autoFocus is off: on a phone, focusing xterm summons the software keyboard
 * over half the viewport, so the keyboard should only appear when the user
 * taps the terminal to type. The page always has layout (it sits off-screen
 * in the sliding track, not display:none), so xterm can open and fit before
 * it is ever revealed.
 */
export function MobileTerminalPage({
  agentIds,
  activeAgentId,
  onStatusChange,
  onRegisterInput,
}: MobileTerminalPageProps) {
  // Fall back to the first terminal when the active agent has no PTY.
  const activeId =
    activeAgentId !== null && agentIds.includes(activeAgentId)
      ? activeAgentId
      : (agentIds[0] ?? null);

  return (
    <div className="relative w-full h-full bg-bg-dark">
      {agentIds.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 px-16 text-center">
          <span className="text-lg text-text">No agent terminals yet</span>
          <span className="text-sm text-text-muted">Tap + in the bar below to launch one</span>
        </div>
      )}
      {agentIds.map((agentId) => (
        // Inactive wrappers must not hit-test: they are full-size transparent
        // overlays stacked in DOM order, so a later agent's empty wrapper
        // would otherwise swallow every tap meant for an earlier active pane.
        <div
          key={agentId}
          className={`absolute left-4 right-4 bottom-4 mobile-safe-pane-top ${
            agentId === activeId ? '' : 'pointer-events-none'
          }`}
        >
          <TerminalPane
            agentId={agentId}
            isActive={agentId === activeId}
            onStatusChange={onStatusChange}
            fontSizePx={MOBILE_TERMINAL_FONT_SIZE_PX}
            autoFocus={false}
            onRegisterInput={onRegisterInput}
          />
        </div>
      ))}
    </div>
  );
}
