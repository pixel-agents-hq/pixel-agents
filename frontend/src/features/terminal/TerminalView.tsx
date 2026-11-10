import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import Box from '@mui/material/Box';
import { useEffect, useRef } from 'react';

import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from '../../constants';
import { TerminalConnection } from './terminalConnection';
import type { TerminalStatus } from './terminalConnection';

interface TerminalViewProps {
  agentId: number;
  onStatusChange: (status: TerminalStatus) => void;
}

/** xterm 自己管理 DOM，所以放在 effect 與 ref 裡，不進 React state。 */
export function TerminalView({ agentId, onStatusChange }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatusChange);
  useEffect(() => {
    statusRef.current = onStatusChange;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE_PX,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: TERMINAL_THEME,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    const connection = new TerminalConnection(agentId, {
      onOutput: (data) => terminal.write(data),
      onReplay: (data, cols, rows) => {
        terminal.reset();
        terminal.resize(cols, rows);
        terminal.write(data);
      },
      onStatusChange: (status) => statusRef.current(status),
    });
    const input = terminal.onData((data) => connection.write(data));
    const size = terminal.onResize(({ cols, rows }) => connection.resize(cols, rows));
    connection.connect();
    terminal.focus();

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fit.fit(), TERMINAL_RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      size.dispose();
      connection.dispose();
      terminal.dispose();
    };
  }, [agentId]);

  return (
    <Box
      ref={hostRef}
      sx={{ flex: 1, minHeight: 0, bgcolor: TERMINAL_THEME.background, p: '8px 12px' }}
    />
  );
}
