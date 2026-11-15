import type { usage as en } from '../en/usage.js';
import type { Strings } from '../types.js';

/** Tiếng Việt: usage. */
export const usage: Strings<typeof en> = {
  weekly: 'Hằng tuần',
  fiveHour: '5 giờ',
  resetLabel: '{name} · {reset}',
  ariaLabel:
    'Mức sử dụng {provider}. Hằng tuần: còn {weeklyPercent}, {weeklyReset}. 5 giờ: còn {fiveHourPercent}, {fiveHourReset}.',
  noData: 'chưa có dữ liệu',
  resetSinceReport: 'đã đặt lại kể từ lần báo cáo trước',
  resetsIn: 'đặt lại sau {duration}',
  updatesOnce: 'Cập nhật khi một phiên {provider} phản hồi',
  updatedJustNow: 'Vừa cập nhật',
  updatedAgo: 'Cập nhật {duration} trước',
};
