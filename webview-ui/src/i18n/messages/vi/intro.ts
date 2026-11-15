import type { intro as en } from '../en/intro.js';
import type { Strings } from '../types.js';

/** Tiếng Việt: intro. */
export const intro: Strings<typeof en> = {
  welcomeTitle: 'Chào mừng bạn đến với Pixel Agents!',
  claudeCodeTitle: 'Chạy bằng Claude Code',
  usageTitle: 'Theo dõi mức sử dụng',
  closingTitle: 'Xong cả rồi!',
  closingFailedTitle: 'Không cài được Hooks',
  stepOf: 'Bước {current} / {total}',
  welcomeBody:
    'Ở văn phòng này, các agent AI của bạn hoá thành những nhân vật pixel tí hon: gõ phím bên bàn khi làm việc, đi dạo khi xong việc, và lên tiếng khi cần bạn.',
  claudeCodeBody:
    'Văn phòng theo dõi các phiên Claude Code của bạn và làm chúng sống động ở đây. Bạn mới dùng Claude Code? Tải về trước nhé:',
  moreInfo: 'Xem thêm tại',
  usageShown: 'Mức sử dụng của bạn giờ hiện ở góc trên bên trái.',
  installFailedBody:
    'Mình gặp lỗi khi ghi vào cài đặt Claude Code của bạn, nên văn phòng sẽ theo dõi các phiên theo cách chậm hơn. Đừng lo, mọi thứ vẫn chạy và bạn có thể thử bật lại bất cứ lúc nào trong Cài đặt.',
  enjoyBody:
    'Chúc bạn vui với văn phòng mới! Có câu hỏi, ý tưởng hay tranh pixel muốn khoe? Ghé chơi Discord của tụi mình nhé.',
  joinDiscord: 'Tham gia Discord!',
  skip: 'Bỏ qua',
  connecting: 'Đang kết nối...',
  showUsage: 'Hiện mức sử dụng',
  dontAskAgain: 'Đừng hỏi lại',
  notNow: 'Để sau',
  installing: 'Đang cài...',
  installHooks: 'Cài Hooks',
  letsGo: 'Bắt đầu thôi',
  continue: 'Tiếp tục',
  migrationTitle: 'Tụi mình xin lỗi bạn!',
  migrationBody:
    'Tụi mình vừa chuyển sang bộ tài nguyên mã nguồn mở hoàn toàn, tự tay làm từ đầu bằng cả tấm lòng. Tiếc là vì vậy bố cục trước đây của bạn phải được đặt lại.',
  migrationSorry: 'Tụi mình thật sự xin lỗi về điều đó.',
  migrationGoodNews:
    'Tin vui? Chuyện này chỉ xảy ra một lần, và nó mở đường cho nhiều cập nhật thú vị sắp tới.',
  migrationThanks: 'Hãy chờ xem nhé, và cảm ơn bạn đã dùng Pixel Agents!',
  gotIt: 'Đã hiểu',
  whatsNewIn: 'Có gì mới trong v{version}',
  contributors: 'Người đóng góp',
  viewOnGitHub: 'Xem trên GitHub',
  updatedTo: 'Đã cập nhật lên v{version}!',
  seeWhatsNew: 'Xem có gì mới',
  seeWhatsNewTooltip: 'Xem có gì mới!',
  loadingOffice: 'Đang tải văn phòng',
};
