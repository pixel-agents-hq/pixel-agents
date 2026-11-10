export const WS_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

export const LAST_WORKSPACE_STORAGE_KEY = 'passon-agents:last-workspace';

export const TOOL_LOG_LIMIT = 200;

export const LAUNCH_TIMEOUT_MS = 15000;

export const TERMINAL_FONT_FAMILY = "'JetBrains Mono', ui-monospace, monospace";
export const TERMINAL_FONT_SIZE_PX = 12.5;
export const TERMINAL_SCROLLBACK_LINES = 5000;
export const TERMINAL_RESIZE_DEBOUNCE_MS = 100;
export const TERMINAL_THEME = {
  background: '#0d0d12',
  foreground: '#c8d0dc',
  cursor: '#5b30d6',
  selectionBackground: 'rgba(91, 48, 214, 0.35)',
};

export const KB_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type KbReviewStatus = (typeof KB_REVIEW_STATUSES)[number];
