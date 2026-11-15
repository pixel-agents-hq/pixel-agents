import type { office as en } from '../en/office.js';
import type { Strings } from '../types.js';

/** Tiếng Việt: office. */
export const office: Strings<typeof en> = {
  needsApproval: 'Cần cấp quyền',
  waitingForInput: 'Đang chờ nhập',
  idle: 'Rảnh',
  subtask: 'Tác vụ con',
  teamLead: 'TRƯỞNG NHÓM',
  closeAgent: 'Đóng agent',
  contextLeft: 'Còn {pct}% ngữ cảnh (đã dùng {used}k / {max}k token)',

  statusReading: 'Đang đọc {file}',
  statusEditing: 'Đang sửa {file}',
  statusWriting: 'Đang ghi {file}',
  statusRunning: 'Đang chạy: {command}',
  statusRunningSubtask: 'Đang chạy tác vụ con',
  statusSearchingFiles: 'Đang tìm tệp',
  statusSearchingCode: 'Đang tìm mã',
  statusFetchingWeb: 'Đang tải nội dung web',
  statusSearchingWeb: 'Đang tìm trên web',
  statusSubtask: 'Tác vụ con: {description}',
  statusWaitingForAnswer: 'Đang chờ bạn trả lời',
  statusPlanning: 'Đang lập kế hoạch',
  statusEditingNotebook: 'Đang sửa notebook',
  statusCreatingTeam: 'Đang tạo nhóm',
  statusCreatingTeamNamed: 'Đang tạo nhóm: {team}',
  statusSendingMessage: 'Đang gửi tin nhắn',
  statusUsing: 'Đang dùng {tool}',
};
