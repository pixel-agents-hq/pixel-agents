import type { Ref } from 'react';
import { useImperativeHandle, useRef } from 'react';

import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import type { TerminalInputHandle } from './TerminalPane.js';
import { TerminalPane } from './TerminalPane.js';

interface TerminalPaneStackProps {
  /** Agent ids with a live PTY, in open order. */
  agentIds: number[];
  /** The pane to show (already resolved by useTerminalDrawer). */
  shownAgentId: number | null;
  onStatusChange: (agentId: number, status: TerminalConnectionStatus) => void;
  /** Positions each pane's wrapper inside the stack (the shells inset differently). */
  paneClassName: string;
  fontSizePx?: number;
  autoFocus?: boolean;
  /** Input into whichever pane is showing — how the mobile key bar types and
   *  pastes. Resolved at call time, so it follows tab switches. */
  inputRef?: Ref<TerminalInputHandle>;
}

/**
 * Every agent's TerminalPane, all mounted, only the shown one visible —
 * buffers and sockets survive tab switches, and unmounting would drop the
 * scrollback and force a reconnect. Shared by the desktop drawer and the
 * mobile terminal page.
 */
export function TerminalPaneStack({
  agentIds,
  shownAgentId,
  onStatusChange,
  paneClassName,
  fontSizePx,
  autoFocus,
  inputRef,
}: TerminalPaneStackProps) {
  const inputs = useRef(new Map<number, TerminalInputHandle>());
  const shownRef = useRef(shownAgentId);
  shownRef.current = shownAgentId;

  useImperativeHandle(
    inputRef,
    () => ({
      send: (data) => {
        if (shownRef.current !== null) inputs.current.get(shownRef.current)?.send(data);
      },
      paste: (data) => {
        if (shownRef.current !== null) inputs.current.get(shownRef.current)?.paste(data);
      },
    }),
    [],
  );

  const registerInput = (agentId: number, handle: TerminalInputHandle | null) => {
    if (handle) inputs.current.set(agentId, handle);
    else inputs.current.delete(agentId);
  };

  return agentIds.map((agentId) => (
    // Inactive wrappers must not hit-test: they are full-size transparent
    // overlays stacked in DOM order, so a later agent's empty wrapper would
    // otherwise swallow every tap or click (focus, text selection) meant for
    // an earlier shown pane.
    <div
      key={agentId}
      className={`absolute ${paneClassName} ${agentId === shownAgentId ? '' : 'pointer-events-none'}`}
    >
      <TerminalPane
        agentId={agentId}
        isActive={agentId === shownAgentId}
        onStatusChange={onStatusChange}
        fontSizePx={fontSizePx}
        autoFocus={autoFocus}
        onRegisterInput={inputRef ? registerInput : undefined}
      />
    </div>
  ));
}
