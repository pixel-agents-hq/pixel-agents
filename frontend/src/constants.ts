export const WS_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

export const LAST_WORKSPACE_STORAGE_KEY = 'passon-agents:last-workspace';

export const TOOL_LOG_LIMIT = 200;
/** 每個子代理保留的最近工具活動筆數 */
export const SUBAGENT_TOOL_LOG_LIMIT = 10;
/** 卡片收合時，每個子代理顯示的最近工具活動筆數 */
export const CARD_SUBAGENT_TOOLS_COLLAPSED = 1;

export const LAUNCH_TIMEOUT_MS = 15000;

export const APP_FONT_FAMILY = "'Hack', ui-monospace, monospace";
export const TERMINAL_FONT_SIZE_PX = 12.5;
export const TERMINAL_SCROLLBACK_LINES = 5000;
export const TERMINAL_RESIZE_DEBOUNCE_MS = 100;
/** Shift+Enter 送出 ESC + CR（等同 Alt+Enter），讓 Claude Code 換行而不是送出 */
export const TERMINAL_SHIFT_ENTER_SEQUENCE = '\x1b\r';
export const TERMINAL_THEME = {
  background: '#0d0d12',
  foreground: '#c8d0dc',
  cursor: '#a78bfa',
  selectionBackground: 'rgba(167, 139, 250, 0.35)',
};

export const KB_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type KbReviewStatus = (typeof KB_REVIEW_STATUSES)[number];
