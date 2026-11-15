import type { terminal as en } from '../en/terminal.js';
import type { Strings } from '../types.js';

/** Tiếng Việt: terminal. */
export const terminal: Strings<typeof en> = {
  agentTitle: 'Agent {id}',
  closeAgent: 'Đóng agent',
  contextLeft: 'Còn {pct}% ngữ cảnh',
  dragToResize: 'Kéo để đổi kích thước',
  hideTerminal: 'Ẩn terminal',
  emptyTitle: 'Chưa có terminal agent nào',
  emptyHint: 'Chạm + ở thanh bên dưới để khởi chạy một agent',
  processExited: 'tiến trình đã thoát với mã {code}',
  copyAsText: 'Sao chép dạng văn bản',
  pastePrompt: 'Dán vào terminal:',
  arrowKeys: 'Phím mũi tên',
};
