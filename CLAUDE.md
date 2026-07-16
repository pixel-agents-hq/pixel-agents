# Pixel Agents - Core Directives

## Build & Run Commands

- **Install:** `npm install` (Root installs all workspaces)
- **Compile:** `npm run compile` (Generates AsyncAPI types, typechecks, lints, esbuilds, vites)
- **Test (Unit):** `npm test` (Vitest for server + webview)
- **Test (E2E):** `npm run e2e` (Playwright)
- **Dev (Webview):** `cd webview-ui && npm run dev`
- **Dev (Watch):** `npm run watch` (esbuild + tsc)

## Architecture & Layering Strict Rules

- **Layering Dependency:** `core/` (Zero dependencies) ← `server/` & `webview-ui/` ← `adapters/vscode/`.
- **Isolation:** `server/src/cli.ts` (standalone) MUST NEVER import from `adapters/vscode/` (and vice-versa).
- **Protocol:** `core/asyncapi.yaml` (v3.0.0) is the SINGLE source of truth. Run `npm run compile` to auto-generate `core/src/messages.ts`. NEVER edit `messages.ts` manually.
- **State:** `AgentStateStore` is the single source of truth for runtime state. Only broadcast layer can call transport methods.
- **Transport:** The ONLY transport branching point allowed is `webview-ui/src/transport/index.ts`. All downstream UI uses `MessageTransport` interface.

## TypeScript Constraints

- **NO `enum`:** Use `as const` objects (e.g., `TileType`, `Direction`).
- **Imports:** Use `import type` for type-only imports (`verbatimModuleSyntax` active). Use `.js` extensions for relative imports in extension/server.
- **Strictness:** `noUnusedLocals` and `noUnusedParameters` are strict. Errors block PRs.
- **Targets:** Module Node16 / ES2022 (Server/Ext).

## UI & Constants Policy

- **No Magic Strings/Numbers:** NEVER inline constants. Use `server/src/constants.ts` (shared), `adapters/vscode/constants.ts` (VS Code specific), or `webview-ui/src/constants.ts`.
- **Pixel Art CSS:** Strict enforcement of CSS variables (`--pixel-bg`, etc.).
- **Shadows/Fonts:** Must use `var(--pixel-shadow)` (or `2px 2px 0px`) and `FS Pixel Sans`.

## Testing Constraints

- **E2E Priority:** Rely on Playwright E2E for UI behavior. Do not write webview UI unit tests for user-facing features.
- **Mocking:** E2E scenarios MUST use `mock-claude`. Never invoke real Claude in tests.
- **Inventory:** Do not manually edit `e2e/README.md`. It is auto-generated via `npm run e2e:inventory` (drift check enforced in CI).
