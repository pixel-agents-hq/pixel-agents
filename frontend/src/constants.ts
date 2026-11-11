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

/** 等待 KB 回覆的上限；超過就放行下一個讀檔請求，不卡住佇列 */
export const KB_REQUEST_TIMEOUT_MS = 10000;
export const KB_TAB_LABEL = '知識庫';
export const KB_TREE_MIN_HEIGHT_PX = 320;
export const KB_TREE_WIDTH_PX = 260;
export const KB_TEXT = {
  notConnected: '尚未連線，無法瀏覽知識庫',
  noRoot: '尚未設定根目錄',
  loading: '載入中…',
  empty: '知識庫裡還沒有檔案',
  truncated: '檔案太多，只顯示部分',
  pickFile: '點選左側的檔案查看內容',
  location: '目前位置',
  parentEntry: '..',
  reading: '讀取中…',
  emptyFile: '（空檔案）',
} as const;
export const KB_REJECTION_TEXT = {
  not_found: '還沒有知識庫資料夾',
  unavailable:
    '此 Agent 目前無法讀取知識庫（已結束、外部接入或重啟還原的 Agent 沒有可信的工作目錄）',
  too_large: '檔案超過 64 KiB 不顯示',
  not_text: '不是可顯示的文字',
  unsafe: '路徑不安全已拒絕',
} as const;

/** 路徑與說明文字過長時，由 CSS 截斷的寬度上限 */
export const ROOT_PATH_MAX_WIDTH_PX = 360;
export const KB_WRITER_NOTE_MAX_WIDTH_PX = 280;
export const WORKSPACE_ROOT_TEXT = {
  label: '根目錄',
  inputLabel: '根目錄路徑（留空表示不啟用）',
  locked: '知識庫已有內容，根目錄無法變更；清空根目錄底下的 .note/ 後才能修改。',
  checking: '正在確認知識庫是否為空…',
  explain:
    '設定根目錄後，整台主機會啟用 KB 寫入規則：所有已知的 Agent 對無法解析的路徑一律拒絕。個人 KB 只能寫在 .note/<角色檔名>/ 之下（沒有角色的 Agent 在 .note 底下什麼都不能寫）。根目錄若落在 ~/.pixel-agents 或 ~/.claude 之下，連 KB Writer 也會被擋。',
  overlapPrefix: '注意：這個路徑與另一個工作空間的根目錄互相包含或相同：',
  confirmTitle: '確認儲存',
  confirmCancel: '取消',
  confirmOk: '確定儲存',
} as const;
export const WORKSPACE_SETTINGS_TEXT = {
  open: '設定',
  title: '工作空間設定',
  back: '返回工作空間',
  nameLabel: '名稱',
  nameHint: '工作空間的顯示名稱',
  directoriesLabel: '包含的目錄',
  directoriesHint:
    '勾選這個工作空間包含的 Directory；已被其他工作空間包含的 Directory 無法選取。工作空間的根目錄不是 Agent 的 Directory，不會出現在這裡。',
  directoriesEmpty: '尚未登記任何 Directory',
  ownedByPrefix: '已屬於：',
  removalNote:
    '移除的 Directory 裡已在執行的 Agent 會繼續執行；若 KB Writer 綁定在該目錄，伺服器會解除綁定。',
  save: '儲存',
  saving: '等待伺服器確認…',
  dirty: '有未儲存的變更',
  unavailable: '預設工作空間沒有設定頁',
} as const;
export const ADD_WORKSPACE_TEXT = {
  rootLabel: '根目錄',
  rootHint: '知識庫 .note/ 所在資料夾；Agent 的 Directory 請在工作空間內另外加入',
  rootNote:
    '已登記為 Directory 的資料夾無法當作根目錄（兩者的 .note/ 位置會重疊），伺服器會拒絕並顯示它的訊息。',
} as const;
export const CURATOR_TEXT = {
  set: '設為 KB Writer',
  unset: '解除 KB Writer',
  swap: '改由此 Agent 擔任',
  pending: '等待伺服器確認…',
  notPersisted: '不會持久保存，伺服器重啟後需重新指定',
  persistedRestore: '重啟後會自動恢復（綁定目錄與角色相同的 Agent）',
  vacancyPrefix: 'KB Writer 職缺：重新啟用 ',
  vacancySuffix: ' 的 Agent 時會自動恢復',
  revoke: '撤銷綁定',
  noRoot: '尚未設定根目錄，指定 KB Writer 不會產生保護',
} as const;
export const GUARD_TEXT = {
  hookLabel: 'Hook 鏈',
  hookVerified: '已驗證',
  hookAwaiting: '尚未驗證（規則仍然適用，但還沒有判定紀錄）',
  hookBroken: '未運作',
  hookNotApplicable: '不適用',
  hookUnknown: '無法判定',
  rulesLabel: 'KB 規則',
  rulesOff: '未啟用（到工作空間頁設定根目錄）',
  rulesOn: '已啟用',
  curatorLabel: '工作空間 KB 寫入者',
  curatorNone: '無人可寫（已鎖定）',
  curatorUnassigned: '未指定',
  summary: 'KB 寫入保護生效中',
  otherReasonLabel: '其他',
} as const;
export const GUARD_REASON_LABELS: Record<string, string> = {
  not_standalone_agent: '不是由本主機啟動的 Agent',
  hooks_not_installed: 'hooks 尚未安裝',
  pretooluse_hook_missing: '缺少 PreToolUse hook',
  hook_script_missing: '找不到 hook 腳本',
  awaiting_first_verdict: '等待第一次判定',
  no_workspace_root: '工作空間沒有根目錄',
  no_curator: '工作空間沒有 KB Writer',
};
