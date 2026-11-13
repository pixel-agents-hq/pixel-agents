# webview-ui/ - React 19 + Canvas office (shared by both Adapters)

Score 17 (114 src files, 7 src subdirs, own Vite/TS/ESLint/Vitest config, `transport` ~15 importers). Children: `src/office/`, `src/terminal/`.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| ServerMessage -> view state | `src/hooks/useExtensionMessages.ts` | ~930 LOC; exports widely used `Directory` type |
| Composition root | `src/App.tsx` | ~880 LOC; imports components directly (no barrels) |
| Transport choice | `src/transport/index.ts` | `serverToken` forwarded as `/ws?token=` |
| Phone shell | `src/mobile/` | reducer (`edgeSwipe.ts`, `keyboardViewport.ts`) + thin DOM hook |
| Intro tour / consent UI | `src/hooks/introTourState.ts`, `src/components/IntroBubble.tsx` | |
| Terminal panes UI | `src/components/Terminal*.tsx`, `src/hooks/useTerminalDrawer.ts` | byte plane in `src/terminal/` |
| e2e canvas inspection | `src/testHooks.ts` | mounted only when `window.__PIXEL_AGENTS_E2E` |
| Dev-only fake server | `src/browserMock.ts` + `vite.config.ts` plugin | Vite dev only |
| Pixel lint rules | `../eslint-rules/pixel-agents-rules.mjs` | `no-inline-colors`, `pixel-shadow`, `pixel-font` |
| Unit tests | `test/*.test.ts` | Node env, NOT jsdom |

## CONVENTIONS
- Tests live in `test/`, not beside source; Vitest `environment: node`, `fileParallelism: false` (fixed Vite ports), 30 s timeout. Anything tested must be DOM-free - hence the reducer + adapter split everywhere.
- TS: bundler resolution, `verbatimModuleSyntax`, `.js` relative specifiers, `import type`.
- Colors: only in `src/constants.ts` (or as `ColorValue`/CSS variables); lint exempts constants, fonts, office sprites.
- ESLint disables React Hooks `immutability`, `refs`, `set-state-in-effect` on purpose: `OfficeState`/`EditorState` are imperative objects outside React.
- Vite: `base: './'`, out `../dist/webview`; dev `allowedHosts` includes `.ts.net`.
- Modals/overlays mount at App top level - the mobile track's transform would capture `position: fixed`.

## ANTI-PATTERNS
- Importing `server/` or `adapters/`; branching on runtime outside `transport/index.ts` (and `isBrowserRuntime` gates).
- `useIsMobile` true in VS Code - it must stay `isBrowserRuntime`-gated.
- Tracking `touches[0]` or a private tap threshold - use `touch/touchPrimitives.ts` (`findTouch`, `withinTapSlop`).
- Rendering consent text from local strings - render the server's copy verbatim; treat a stale/failed install verdict as failure.
- Hit-testing inactive terminal panes; letting vertical mobile drags pan the page.

## COMMANDS
```bash
npm run test:webview          # from root (vitest run)
npm run dev -w webview-ui     # Vite + browser mock
npm run build:webview         # tsc -b && vite build
```
