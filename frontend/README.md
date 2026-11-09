# passon agents 前端

這是 passon agents（原 pixel-agents）的新前端，用來取代 `webview-ui/`。本專案目前是**可運作的骨架**：技術組合、專案結構、與後端的連線方式都已就緒，畫面只有一個範例功能。

## 目前狀態

| 項目 | 狀態 |
|---|---|
| Vite、React、TypeScript、Redux Toolkit、redux-saga、MUI | 已安裝並運作 |
| 範例功能：後端連線狀態卡片（`features/server`） | 已完成，含單元測試 |
| 開發時代理後端 `/api` 與 `/ws` | 已設定；`/api` 已驗證，`/ws` 尚未驗證 |
| WebSocket 客戶端與 `core/asyncapi.yaml` 的協定整合 | 尚未實作 |
| 登入權杖（token）處理 | 尚未實作 |
| 路由、Agent 清單、終端機、工作空間、KB 審核等畫面 | 尚未實作 |
| 設計稿對應的頁面 | 尚未實作 |
| 端對端（e2e）測試 | 尚未建立 |
| 納入根目錄的 npm workspace、CI | 尚未納入；本專案是獨立的 `package.json` |

根目錄的 `npm run lint`、`check-types`、`format`、`knip` 都使用明確的目錄清單，不會掃描 `frontend/`，所以本專案不影響既有的 CI。

## 技術組合

| 用途 | 套件 | 版本（安裝時） |
|---|---|---|
| 建置與開發伺服器 | Vite | 8.3 |
| UI | React | 19.3 |
| 語言 | TypeScript | 7.0 |
| 狀態管理 | Redux Toolkit、react-redux | 2.14、9.3 |
| 非同步流程 | redux-saga | 1.5 |
| 元件庫 | MUI（`@mui/material`）加 emotion | 9.5 |
| 測試 | vitest | 5.1 |
| Lint | oxlint | 1.93 |

文件：[Redux Toolkit](https://redux.js.org/toolkit/)、[redux-saga](https://redux-saga.js.org/)、[MUI](https://mui.com/material-ui/)、[Vite](https://vite.dev/)。

## 快速開始

需要 Node.js 22.12 以上（vitest 5 的要求；Vite 8 本身接受 20.19 以上，但無法跑測試）。本專案使用 npm（整個倉庫只有 `package-lock.json`）。

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

用瀏覽器開 `http://localhost:5173`，按「檢查連線」，卡片會顯示後端的 `status`、`pid`、`uptime`。

注意：請用 `localhost`，不要用 `127.0.0.1`。Vite 預設綁定 `localhost`，在部分機器上會解析成 IPv6（`::1`），用 `127.0.0.1` 會連不上。

### 指令

| 指令 | 說明 |
|---|---|
| `npm run dev` | 開發伺服器（預設埠 5173，可用 `-- --port 5199` 指定） |
| `npm run build` | 型別檢查加正式建置，輸出到 `dist/` |
| `npm run preview` | 預覽建置結果 |
| `npm run lint` | oxlint |
| `npm test` | vitest（單次執行） |

### 設定後端位址

開發時 Vite 會把 `/api`、`/ws` 代理到後端，預設是 `http://127.0.0.1:3100`。後端在別的位址時：

```bash
BACKEND_URL=http://127.0.0.1:4000 npm run dev
```

設定在 `vite.config.ts`。這個代理只在 `npm run dev` 有效；正式部署時要由反向代理處理，或讓後端提供前端檔案。

## 目錄結構

```
frontend/
  index.html
  vite.config.ts           開發代理設定
  src/
    main.tsx               入口：Provider、ThemeProvider、CssBaseline
    App.tsx                版面
    theme.ts               MUI 主題（目前是深色）
    app/
      store.ts             configureStore 加 saga middleware；匯出 RootState、AppDispatch
      rootSaga.ts          把各功能的 saga 組合起來
      hooks.ts             型別化的 useAppDispatch、useAppSelector
    features/
      server/              範例功能：後端連線狀態
        serverSlice.ts     狀態與 action（Redux Toolkit）
        serverSaga.ts      非同步流程（redux-saga）
        serverSaga.test.ts saga 的單元測試
        ServerStatusCard.tsx  MUI 元件
```

慣例：一個功能一個資料夾，放在 `src/features/<名稱>/`，裡面有 slice、saga、元件與測試。

## 資料流

```
元件 dispatch(action)
   -> reducer 先處理（同步，例如 healthRequested 把狀態設為 loading）
   -> saga 攔截同一個 action（takeLatest），執行非同步工作（fetch）
   -> saga 用 put(action) 回報結果（healthSucceeded 或 healthFailed）
   -> reducer 更新狀態 -> 元件重新渲染
```

reducer 負責「狀態怎麼變」，saga 負責「什麼時候、怎麼去拿資料」。saga 不直接改狀態，只發出 action。

## 教學：新增一個功能

下面以「每 5 秒自動輪詢後端狀態」為例，示範一個功能要動哪些地方。這個範例已在暫存複本中驗證過（型別檢查、測試、建置都通過），但**沒有**寫進本專案的原始碼，你可以照著做一次。

### 步驟一：在 slice 加上狀態與 action

`src/features/server/serverSlice.ts`：

```ts
interface ServerState {
  request: ServerRequestState
  health: HealthInfo | null
  error: string | null
  polling: boolean            // 新增
}

const initialState: ServerState = {
  request: 'idle',
  health: null,
  error: null,
  polling: false,             // 新增
}

// 在 reducers 裡新增兩個：
    pollingStarted(state) {
      state.polling = true
    },
    pollingStopped(state) {
      state.polling = false
    },

// 匯出時加上：
export const { healthRequested, healthSucceeded, healthFailed, pollingStarted, pollingStopped } =
  serverSlice.actions
```

Redux Toolkit 的 reducer 裡可以直接寫 `state.polling = true`，它內部用 Immer 轉成不可變更新。這個寫法只能在 `createSlice` 的 reducer 裡用。

### 步驟二：寫 saga

`src/features/server/serverSaga.ts`，先改匯入：

```ts
import { call, delay, put, race, take, takeLatest } from 'redux-saga/effects'
```

再新增：

```ts
export const POLL_INTERVAL_MS = 5000

export function* pollHealth() {
  while (true) {
    yield call(fetchHealth)
    yield delay(POLL_INTERVAL_MS)
  }
}

// 等到 pollingStarted 才開始輪詢，收到 pollingStopped 就取消。
export function* watchPolling() {
  while (true) {
    yield take(pollingStarted.type)
    yield race({
      poll: call(pollHealth),
      stop: take(pollingStopped.type),
    })
  }
}
```

最後在 `serverSaga` 裡啟動它：

```ts
export function* serverSaga() {
  yield takeLatest(healthRequested.type, fetchHealth)
  yield call(watchPolling)
}
```

重點：

- `call(fn)` 呼叫函式並等待結果；`yield` 會讓 saga 暫停，直到結果回來。
- `delay(ms)` 等待一段時間。
- `take(type)` 等待某個 action 出現。
- `race({ a, b })` 同時等多件事，**第一個完成的勝出，其他的自動取消**。這就是「停止輪詢」不需要自己管計時器的原因。

`rootSaga.ts` 不用改，因為 `serverSaga` 已經在裡面。新的功能資料夾則要在 `rootSaga` 的 `all([...])` 加上 `fork(新功能Saga)`，並在 `store.ts` 的 `reducer` 加上新的 slice reducer。

### 步驟三：在元件使用

`src/features/server/ServerStatusCard.tsx`：

```tsx
import { healthRequested, pollingStarted, pollingStopped } from './serverSlice'

const { request, health, error, polling } = useAppSelector((state) => state.server)

// 在 <CardActions> 裡新增：
<Button onClick={() => dispatch(polling ? pollingStopped() : pollingStarted())}>
  {polling ? '停止輪詢' : '開始輪詢'}
</Button>
```

用 `hooks.ts` 匯出的 `useAppSelector`、`useAppDispatch`，不要直接用 react-redux 的 `useSelector`、`useDispatch`，這樣才有型別提示。

### 步驟四：寫測試

`src/features/server/pollHealth.test.ts`。重點是用 redux-saga 官方的 `runSaga` 加 `stdChannel` 手動送入 action，再用 vitest 的假計時器推進時間：

```ts
import { runSaga, stdChannel } from 'redux-saga'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { watchPolling } from './serverSaga'
import { healthSucceeded, pollingStarted, pollingStopped } from './serverSlice'
import type { HealthInfo } from './serverSlice'

describe('watchPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fetches repeatedly while polling and stops after pollingStopped', async () => {
    const health: HealthInfo = { status: 'ok', uptime: 1, pid: 1 }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(health)))
    vi.stubGlobal('fetch', fetchMock)

    const dispatched: unknown[] = []
    const channel = stdChannel()
    const task = runSaga(
      { channel, dispatch: (action: unknown) => dispatched.push(action) },
      watchPolling,
    )

    channel.put(pollingStarted())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)
    const callsWhilePolling = fetchMock.mock.calls.length
    expect(callsWhilePolling).toBeGreaterThanOrEqual(2)
    expect(dispatched).toContainEqual(healthSucceeded(health))

    channel.put(pollingStopped())
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetchMock.mock.calls.length).toBe(callsWhilePolling)

    task.cancel()
  })
})
```

簡單的 saga（例如 `fetchHealth`）可以直接看 `serverSaga.test.ts`：用 `runSaga` 執行，收集 `dispatch` 的 action，再比對。測試時用 `vi.stubGlobal('fetch', ...)` 取代真正的網路請求。

### 驗證

```bash
npx tsc -b      # 型別檢查
npm test        # 單元測試
npm run lint
npm run build
```

## 教學：使用 MUI

- 元件從 `@mui/material/<元件名>` 個別匯入（本專案的寫法，例如 `import Button from '@mui/material/Button'`），建置結果較小。
- 排版優先用 `Stack`（一維排列加間距）、`Container`（置中與最大寬度）、`Box`。
- 客製樣式用 `sx` 屬性：`<Card sx={{ mb: 2 }}>`。數字會依主題的間距單位換算（`mb: 2` 是 `2 * 8px`）。
- 全域配色與字型改 `src/theme.ts` 的 `createTheme`，不要在各元件寫死顏色。
- 圖示需要另外安裝 `@mui/icons-material`，目前沒有安裝。

## 與後端連線

後端是 `server/` 的 Node.js 伺服器（Fastify）。可用的入口：

| 入口 | 用途 | 本前端目前是否使用 |
|---|---|---|
| `GET /api/health` | 存活檢查，回傳 `status`、`uptime`、`pid` | 是（範例功能） |
| `GET /ws` | 與後端的雙向協定通道 | 否 |
| `POST /api/hooks/:providerId` | Claude Code 的 hook 事件進入點 | 否（由 hook 腳本使用） |
| `/terminal/:agentId` | 網頁終端機的 WebSocket | 否 |

`/ws` 傳遞的訊息格式定義在倉庫根目錄的 `core/asyncapi.yaml`，由它產生 `core/src/messages.ts` 的 TypeScript 型別（ServerMessage、ClientMessage）。舊前端透過 `MessageTransport` 介面（`webview-ui/src/transport/`）收發這些訊息。

整合 WebSocket 時的建議做法（尚未實作）：

1. 用 saga 管理連線：`eventChannel` 包裝 WebSocket 的事件，收到的訊息轉成 Redux action；用 `takeEvery` 把要送出的 action 寫進 socket。
2. 重連採指數退避，參考舊前端 `webSocketTransport.ts`（250 毫秒、500 毫秒、1 秒、2 秒、4 秒為上限）。
3. 型別直接從 `core/src/messages.ts` 匯入，不要重複定義。

特權操作（啟動 Agent、改設定等）需要伺服器權杖。依倉庫根目錄 `CLAUDE.md` 的說明，standalone 伺服器啟動時會在終端機印出含權杖的網址，`/ws` 以 `?token=` 查詢參數帶入；沒有權杖的連線是唯讀。這部分本前端尚未處理，**也尚未驗證**經過 Vite 代理後 `/ws` 的 Origin 與 Host 檢查是否通過，開始整合時請先實測。

## 已知限制與注意事項

- 本專案是獨立專案，沒有加入根目錄的 npm workspace，依賴要在 `frontend/` 內單獨 `npm install`。
- 程式碼風格與根目錄的 ESLint、Prettier 規則不同：本專案用 oxlint，沒有套用舊前端的自訂規則（例如禁止行內顏色、像素風格限制）。要不要統一，需要另外決定。
- 沒有路由，也沒有多頁面結構；加入畫面前先決定路由方案。
- 沒有 `@mui/icons-material`。
- TypeScript 7.0 是 Vite 範本當時產生的版本，未做過版本評估。
- 設計稿（`passon-agents-dashboard`）的畫面都還沒有實作。
