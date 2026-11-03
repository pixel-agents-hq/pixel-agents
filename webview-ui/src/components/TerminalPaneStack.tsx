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
  onStatusChange: (agentId: number, status: TerminalConnectionStatus | null) => void;
  /** Positions each pane's wrapper inside the stack (the shells inset differently). */
  paneClassName: string;
  fontSizePx?: number;
  autoFocus?: boolean;
  /** Keep every agent's pane mounted, the hidden ones too (desktop): a
   *  switch shows a pane that is already live. Off (the phone), only the
   *  shown pane exists — each hidden xterm holds its scrollback and parses
   *  all of its agent's output, which a phone's memory can't afford, and a
   *  pane that mounts gets its screen and scrollback back from the server's
   *  replay anyway. */
  keepHidden: boolean;
  /** Input into whichever pane is showing — how the mobile key bar types.
   *  Resolved at call time, so it follows tab switches. */
  inputRef?: Ref<TerminalInputHandle>;
}

/**
 * The agents' TerminalPanes, only the shown one visible: all of them mounted
 * (`keepHidden`) or just the shown one. Shared by the desktop drawer and the
 * mobile terminal page.
 */
export function TerminalPaneStack({
  agentIds,
  shownAgentId,
  onStatusChange,
  paneClassName,
  fontSizePx,
  autoFocus,
  keepHidden,
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
      cols: () =>
        shownRef.current !== null ? (inputs.current.get(shownRef.current)?.cols() ?? 0) : 0,
    }),
    [],
  );

  const registerInput = (agentId: number, handle: TerminalInputHandle | null) => {
    if (handle) inputs.current.set(agentId, handle);
    else inputs.current.delete(agentId);
  };

  const mounted = keepHidden ? agentIds : agentIds.filter((id) => id === shownAgentId);
  return mounted.map((agentId) => (
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
