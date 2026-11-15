import type { launch as en } from '../en/launch.js';
import type { Strings } from '../types.js';

/** Tiếng Việt: launch. */
export const launch: Strings<typeof en> = {
  addDirectoryRow: '+ Thư mục',
  hostBadge: 'máy chủ',
  editNamed: 'Sửa {name}',
  editDirectoryTitle: 'Sửa thư mục',
  launchAs: 'Khởi chạy với {name}',
  launchAsIn: 'Khởi chạy với {name} trong {directory}',
  showAll: 'Hiện tất cả',
  showAllCharacters: 'Hiện cả {count} nhân vật của {directory}',
  addDirectory: 'Thêm Thư mục',
  editDirectory: 'Sửa Thư mục',
  name: 'Tên',
  namePlaceholder: 'Tên dự án',
  path: 'Đường dẫn',
  pathPlaceholder: '~/code/my-project',
  recentDirectories: 'Thư mục làm việc gần đây',
  areas: 'Khu vực',
  characters: 'Nhân vật',
  orderPriority: 'Ưu tiên',
  orderRandom: 'Ngẫu nhiên',
  removeCharacter: 'Bỏ {name}',
  addCharacter: 'Thêm {name}',
  addDefaultCharacter: 'Thêm nhân vật mặc định',
  noDefaults: 'Chưa có: agent khởi chạy ở đây mặc một nhân vật ngẫu nhiên chưa ai mặc.',
  orderHintPriority:
    'Agent khởi chạy ở đây mặc nhân vật đầu tiên chưa có trong văn phòng; khi tất cả đã có mặt thì mặc một nhân vật chưa ai mặc.',
  orderHintRandom:
    'Agent khởi chạy ở đây mặc một nhân vật ngẫu nhiên chưa có trong văn phòng; khi tất cả đã có mặt thì mặc một nhân vật chưa ai mặc.',
};
