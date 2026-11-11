import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

const FALLBACK_BACKEND_URL = 'http://127.0.0.1:3100';
const SERVER_DISCOVERY_FILE = path.join(homedir(), '.pixel-agents', 'server.json');

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 後端預設使用系統指派的隨機 port，並把 port 與 pid 寫進 server.json；
// 只採用 pid 仍存活的紀錄，避免連到已結束的後端留下的舊 port。
function discoverBackendUrl() {
  try {
    const { port, pid } = JSON.parse(readFileSync(SERVER_DISCOVERY_FILE, 'utf8')) as {
      port?: unknown;
      pid?: unknown;
    };
    if (typeof port === 'number' && typeof pid === 'number' && isProcessAlive(pid)) {
      return `http://127.0.0.1:${port}`;
    }
  } catch {
    // 檔案不存在或內容無法解析時，退回預設值
  }
  return FALLBACK_BACKEND_URL;
}

const BACKEND_URL = process.env.BACKEND_URL ?? discoverBackendUrl();
console.log(`[vite] backend proxy -> ${BACKEND_URL}`);

// 瀏覽器重新整理或關閉分頁時，WebSocket 會被對端重置；Vite 對代理的每個錯誤都印出堆疊，
// 這兩種代碼是正常斷線，不需要輸出。其他錯誤照常顯示。
const BENIGN_SOCKET_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE']);
const WS_PROXY_MESSAGE_PREFIX = 'ws proxy';

const logger = createLogger();
const logError = logger.error;
logger.error = (message, options) => {
  const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code;
  const isBenignWsProxyError =
    message.includes(WS_PROXY_MESSAGE_PREFIX) &&
    code !== undefined &&
    BENIGN_SOCKET_ERROR_CODES.has(code);
  if (!isBenignWsProxyError) logError(message, options);
};

// 後端以 `npm run start:server` 單獨啟動；開發時由 Vite 代理 API 與兩個 WebSocket（/ws、/terminal）。
export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: false },
      '/ws': { target: BACKEND_URL, ws: true, changeOrigin: false },
      '/terminal': { target: BACKEND_URL, ws: true, changeOrigin: false },
    },
  },
});
