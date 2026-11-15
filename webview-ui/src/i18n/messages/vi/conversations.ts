import type { conversations as en } from '../en/conversations.js';
import type { Strings } from '../types.js';

/** Tiếng Việt: conversations. */
export const conversations: Strings<typeof en> = {
  noDirectories: 'Chưa có thư mục nào.',
  seeAll: 'Xem tất cả',
  recent: 'Gần đây',
  noConversations: 'Không có cuộc trò chuyện',
  byDirectory: 'Theo thư mục',
  searchConversations: 'Tìm cuộc trò chuyện',
  showMore: 'Hiện thêm {count}',
  goTo: 'Đi tới "{title}"',
  resume: 'Tiếp tục "{title}"',
  statusRunning: 'đang chạy',
  statusIdle: 'đang rảnh',
  statusWorking: 'đang làm việc',
  statusAttention: 'cần chú ý',
  statusDisconnected: 'mất kết nối',
  title: 'Cuộc trò chuyện',
  searchIn: 'Tìm trong {name}',
  searchEveryDirectory: 'Tìm trong mọi thư mục',
  searching: 'Đang tìm…',
  noMatches: 'Không có cuộc trò chuyện nào khớp.',
  noConversationsYet: 'Chưa có cuộc trò chuyện nào.',
  loadingMore: 'Đang tải thêm…',
  sidebarLabel: 'Cuộc trò chuyện gần đây',
};
