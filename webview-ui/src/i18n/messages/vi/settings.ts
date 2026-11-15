import type { settings as en } from '../en/settings.js';
import type { Strings } from '../types.js';

/** Tiếng Việt: hộp Cài đặt. */
export const settings: Strings<typeof en> = {
  openSessionsFolder: 'Mở thư mục phiên',
  exportLayout: 'Xuất bố cục',
  importLayout: 'Nhập bố cục',
  assetDirPlaceholder: 'Đường dẫn tuyệt đối tới thư mục tài nguyên',
  addAssetDirectory: 'Thêm thư mục tài nguyên',
  soundNotifications: 'Âm thanh thông báo',
  musicPlayer: 'Trình phát nhạc',
  musicPlayerTitle: 'Trình phát radio văn phòng, ở cuối văn phòng',
  watchAllSessions: 'Theo dõi mọi phiên',
  hooks: 'Phát hiện tức thì (Hooks)',
  usageBars: 'Thanh mức sử dụng',
  usageBarsTitle: 'Mức sử dụng gói {provider} theo tuần và 5 giờ, ở góc trên bên trái',
  alwaysShowLabels: 'Luôn hiện nhãn',
  ghostHeadless: 'Hiện agent không terminal dạng bóng ma',
  showAreas: 'Hiện khu vực',
  skipPermissions: 'Bỏ qua cấp quyền',
  showStartDirectory: 'Hiện thư mục khởi chạy',
  showWorkspaceFolders: 'Hiện thư mục workspace',
  debugView: 'Chế độ gỡ lỗi',
  usageConfirmTitle: 'Hiện thanh mức sử dụng?',
  connect: 'Kết nối',
  language: 'Ngôn ngữ',
  languageAuto: 'Tự động',
  languageAutoTitle: 'Theo ngôn ngữ của trình duyệt',
};
