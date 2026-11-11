# passon agents 前端

這是 passon agents（原 pixel-agents）的新前端，用來取代 `webview-ui/`。設計稿的主要畫面都已實作，並接上後端的 `/ws` 與終端機。

## 目前狀態

| 項目                                                                                                            | 狀態                                    |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Vite、React、TypeScript、Redux Toolkit、redux-saga、MUI、react-router                                           | 已安裝並運作                            |
| 路由與頁面：Dashboard、新增 Agent、Agent 詳情（Session Log、Files Changed、Role Activity）、Terminal、KB Review | 已實作，見「路由」                      |
| `/ws` 連線與 `core/asyncapi.yaml` 協定整合（連線、重連、token）                                                 | 已實作，已對真實後端驗證連線與畫面      |
| Terminal（xterm 接 `/terminal/:agentId`）                                                                       | 已實作；尚未對真實 Agent 驗證輸入輸出   |
| Files Changed 分頁、KB Review 的審核清單                                                                        | 只有空狀態：協定沒有對應的訊息          |
| 設定頁（Settings）                                                                                              | 未實作：設計稿沒有對應畫面              |
| 端對端（e2e）測試                                                                                               | 尚未建立                                |
| 納入根目錄的 npm workspace、CI                                                                                  | 尚未納入；本專案是獨立的 `package.json` |

根目錄的 `npm run lint`、`check-types`、`format`、`knip` 都使用明確的目錄清單，不會掃描 `frontend/`，所以本專案不影響既有的 CI。

## 技術組合

| 用途             | 套件                                        | 版本（安裝時） |
| ---------------- | ------------------------------------------- | -------------- |
| 建置與開發伺服器 | Vite                                        | 8.3            |
| UI               | React                                       | 19.3           |
| 語言             | TypeScript                                  | 7.0            |
| 狀態管理         | Redux Toolkit、react-redux                  | 2.14、9.3      |
| 非同步流程       | redux-saga                                  | 1.5            |
| 元件庫           | MUI（`@mui/material`）加 emotion            | 9.5            |
| 路由             | react-router                                | 7              |
| 終端機           | xterm（`@xterm/xterm`、`@xterm/addon-fit`） | 6.0、0.11      |
| 測試             | vitest                                      | 5.1            |
| Lint             | oxlint                                      | 1.93           |

文件：[Redux Toolkit](https://redux.js.org/toolkit/)、[redux-saga](https://redux-saga.js.org/)、[MUI](https://mui.com/material-ui/)、[Vite](https://vite.dev/)。

## 快速開始

需要 Node.js 22.12 以上（react-router 8 要求 22.22 以上，所以本專案用 7）（vitest 5 的要求；Vite 8 本身接受 20.19 以上，但無法跑測試）。本專案使用 npm（整個倉庫只有 `package-lock.json`）。

```bash
# 終端機 1：在倉庫根目錄只啟動後端（不提供舊的網頁）
npm install
npm run build              # 第一次需要，產生 dist/cli.js
npm run start:server -- --port 3100

# 終端機 2：啟動前端
cd frontend
npm install
npm run dev
```

用瀏覽器開後端啟動時印出的網址，把埠號換成前端的 `5173`，保留 `?token=...`，例如 `http://localhost:5173/?token=<token>`。沒有 token 的連線是唯讀：可以看，不能啟動 Agent、不能開終端機。

注意：請用 `localhost`，不要用 `127.0.0.1`。Vite 預設綁定 `localhost`，在部分機器上會解析成 IPv6（`::1`），用 `127.0.0.1` 會連不上。

### 指令

| 指令              | 說明                                                  |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | 開發伺服器（預設埠 5173，可用 `-- --port 5199` 指定） |
| `npm run build`   | 型別檢查加正式建置，輸出到 `dist/`                    |
| `npm run preview` | 預覽建置結果                                          |
| `npm run lint`    | oxlint                                                |
| `npm test`        | vitest（單次執行）                                    |

### 設定後端位址

開發時 Vite 會把 `/api`、`/ws` 代理到後端，預設是 `http://127.0.0.1:3100`。後端在別的位址時：

```bash
BACKEND_URL=http://127.0.0.1:4000 npm run dev
```

設定在 `vite.config.ts`。這個代理只在 `npm run dev` 有效；正式部署時要由反向代理處理，或讓後端提供前端檔案。

## 路由

設計稿有兩種側欄，各對應一個版面：`ManagementShell`（220px，列出所有工作空間）給新增工作空間、新增 Agent、All Agents；`WorkspaceShell`（240px，工作空間下拉加 Agent 清單）給 `/w/:workspaceId` 底下的頁面。工作空間放在網址裡，所以連結可分享、重新整理後停在原處。`/` 會轉址到上次選的工作空間（沒有就用預設）。

| 路徑                                       | 畫面                                                     |
| ------------------------------------------ | -------------------------------------------------------- |
| `/w/:workspaceId`                          | Dashboard                                                |
| `/w/:workspaceId/agents/new`               | 新增 Agent                                               |
| `/w/:workspaceId/agents/:agentId`          | 轉址到 Claude Code 分頁（點 Agent 的落點）               |
| `/w/:workspaceId/agents/:agentId/claude`   | Claude Code：完整終端機輸出，可直接輸入                  |
| `/w/:workspaceId/agents/:agentId/log`      | Session Log                                              |
| `/w/:workspaceId/agents/:agentId/files`    | Files Changed                                            |
| `/w/:workspaceId/agents/:agentId/roles`    | Role Activity                                            |
| `/w/:workspaceId/agents/:agentId/terminal` | Terminal                                                 |
| `/w/:workspaceId/kb-review/:status`        | KB Review，`status` 為 `pending`、`approved`、`rejected` |

Agent 的工作空間與網址對不上時，會轉址到正確的工作空間。資料來自 WebSocket 與 Redux，所以沒有用 react-router 的 data loader。網址上的 `?token=` 會在路由切換時補回去，書籤才不會失效。

## 目錄結構

```
frontend/
  index.html
  vite.config.ts           開發代理設定
  src/
    main.tsx               入口：Provider、ThemeProvider、RouterProvider
    router.tsx             路由表
    protocol.ts            從 core/ 匯入的協定型別與常數（不在前端重複定義）
    constants.ts           前端常數
    theme.ts               MUI 主題與角色、狀態色票
    app/                   store、rootSaga、型別化的 hooks
    layout/                RootLayout、WorkspaceShell、ManagementShell、兩種側欄、HomeRedirect
    components/            共用元件：AgentCard、RoleBadge、StatusDot ...
    pages/                 各頁面；pages/agent/ 是 Agent 詳情與 Terminal
    features/
      connection/          /ws 連線（saga）、連線狀態、token
      workspaces/          工作空間、目錄、KB Writer（curator）
      agents/              Agent 狀態與工具紀錄、狀態推導
      launch/              啟動 Agent 的流程（含指定 KB Writer）
      terminal/            xterm 與 /terminal/:agentId 連線
```

慣例：一個功能一個資料夾，放在 `src/features/<名稱>/`，裡面有 slice、saga、元件與測試。

## 資料流

```
後端 /ws -> connectionSaga（eventChannel）-> serverMessageReceived
   -> workspaces、agents、connection 各 slice 的 extraReducers 依訊息類型更新
   -> 元件用 selector 讀取

元件 dispatch(clientMessageRequested(訊息)) -> connectionSaga 寫入 socket
```

reducer 負責「狀態怎麼變」，saga 負責「什麼時候、怎麼去拿資料」。saga 不直接改狀態，只發出 action。

## 教學：使用 MUI

- 元件從 `@mui/material/<元件名>` 個別匯入（本專案的寫法，例如 `import Button from '@mui/material/Button'`），建置結果較小。
- 排版優先用 `Stack`（一維排列加間距）、`Container`（置中與最大寬度）、`Box`。
- 客製樣式用 `sx` 屬性：`<Card sx={{ mb: 2 }}>`。數字會依主題的間距單位換算（`mb: 2` 是 `2 * 8px`）。
- 全域配色與字型改 `src/theme.ts` 的 `createTheme`，不要在各元件寫死顏色。
- 圖示需要另外安裝 `@mui/icons-material`，目前沒有安裝。

## 與後端連線

後端是 `server/` 的 Node.js 伺服器（Fastify）。可用的入口：

| 入口                          | 用途                                     | 本前端目前是否使用     |
| ----------------------------- | ---------------------------------------- | ---------------------- |
| `GET /api/health`             | 存活檢查，回傳 `status`、`uptime`、`pid` | 否                     |
| `GET /ws`                     | 與後端的雙向協定通道                     | 是                     |
| `POST /api/hooks/:providerId` | Claude Code 的 hook 事件進入點           | 否（由 hook 腳本使用） |
| `/terminal/:agentId`          | 網頁終端機的 WebSocket                   | 是                     |

`/ws` 傳遞的訊息格式定義在倉庫根目錄的 `core/asyncapi.yaml`，由它產生 `core/src/messages.ts` 的 TypeScript 型別（ServerMessage、ClientMessage）。舊前端透過 `MessageTransport` 介面（`webview-ui/src/transport/`）收發這些訊息。

連線由 `features/connection/connectionSaga.ts` 管理：連上後送 `webviewReady`，之後把每則 `ServerMessage` 轉成 `serverMessageReceived` action；斷線以 250 毫秒到 4 秒的階梯重連。網址上有 `?token=` 才是特權連線（啟動 Agent、改工作空間、開終端機），沒有則唯讀。開發時透過 Vite 代理連到後端，已實測 `/ws` 能通過 Origin 與 Host 檢查。

## 已知限制與注意事項

- 本專案是獨立專案，沒有加入根目錄的 npm workspace，依賴要在 `frontend/` 內單獨 `npm install`。
- 程式碼風格與根目錄的 ESLint、Prettier 規則不同：本專案用 oxlint，沒有套用舊前端的自訂規則（例如禁止行內顏色、像素風格限制）。要不要統一，需要另外決定。
- 沒有 `@mui/icons-material`。
- TypeScript 7.0 是 Vite 範本當時產生的版本，未做過版本評估。
- 設計稿中沒有後端資料可用的部分只做了空狀態：Files Changed、KB Review 的審核清單；設計稿的 Settings 沒有畫面，未實作。
- 啟動 Agent 與終端機輸入輸出尚未對真實 Agent 驗證（會消耗模型用量）。
