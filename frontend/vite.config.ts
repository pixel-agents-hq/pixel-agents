import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:3100'

// 後端以 `npm run start:server` 單獨啟動；開發時由 Vite 代理 API 與 WebSocket。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: false },
      '/ws': { target: BACKEND_URL, ws: true, changeOrigin: false },
    },
  },
})
