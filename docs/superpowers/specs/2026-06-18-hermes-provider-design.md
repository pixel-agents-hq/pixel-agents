# Hermes Provider for pixel-agents

**Date:** 2026-06-18  
**Status:** Approved

## Overview

Add a Hermes HookProvider to pixel-agents so that sessions started with the Hermes CLI (`hermes chat`) appear as animated characters in the pixel-agents office, identical to how Claude Code sessions appear today.

Hermes is a multi-provider AI coding agent (v0.16.0 by Nous Research) that supports anthropic, openai-codex, copilot, gemini, and openrouter backends. It has a native shell-hooks system in `~/.hermes/config.yaml`.

## Scope

**In scope:**

- Server-side `HookProvider` implementation for Hermes
- Hook installer that reads/writes `~/.hermes/config.yaml`
- Hook script that Hermes executes on each event and POSTs to the pixel-agents server
- esbuild bundling of the hook script
- Export from the providers registry

**Out of scope:**

- "Launch Hermes" button in the VS Code UI (no changes to `adapters/vscode/agentManager.ts`)
- Subagent character spawning (`subagent_stop` event ignored in v1)
- Hermes session transcript file watching (hook-only, no file fallback)

## Files

### New files

```
server/src/providers/hook/hermes/
  constants.ts              — hook script name, terminal prefix, Hermes event names
  hooks/hermes-hook.ts      — script Hermes executes; reads stdin, POSTs to server
  hermesHookInstaller.ts    — install/uninstall entries in ~/.hermes/config.yaml
  hermes.ts                 — HookProvider implementation
```

### Modified files

```
server/src/providers/index.ts             — add: export { hermesProvider } from './hook/hermes/hermes.js'
server/src/hookEventHandler.ts            — change single provider → Map<string, HookProvider>; look up by providerId in handleEvent
server/src/agentRuntime.ts               — change constructor to accept HookProvider[]; build map; keep primary (Claude) for transcript/fileWatcher setup
adapters/vscode/PixelAgentsViewProvider.ts — import hermesProvider; pass both to AgentRuntime; install/uninstall Hermes hooks; union readingTools + subagentToolNames
esbuild.js                               — add second buildSync for hermes-hook.ts → dist/hooks/
server/package.json                      — add js-yaml + @types/js-yaml to dependencies
```

### Why hookEventHandler and agentRuntime need changes

`HookEventHandler` currently takes a single `provider: HookProvider` and uses `this.provider.normalizeHookEvent()` for all events, ignoring the `_providerId` parameter in `handleEvent`. Without this fix, Hermes events would arrive at the server but be normalized by the Claude parser — producing `null` for every event (Claude's normalizer doesn't understand Hermes payloads).

The fix is minimal: `HookEventHandler` receives a `Map<string, HookProvider>` and looks up the correct provider per event. `AgentRuntime` builds this map from a `HookProvider[]` array, keeping Claude as the primary provider for transcript/fileWatcher setup (unchanged behavior for existing Claude sessions).

## Event Mapping

| Hermes hook event  | AgentEvent kind | Fields used                                                           |
| ------------------ | --------------- | --------------------------------------------------------------------- |
| `on_session_start` | `sessionStart`  | `session_id`, `model` (as `source`)                                   |
| `pre_tool_call`    | `toolStart`     | `tool_call_id` → `toolId`, `tool_name` → `toolName`, `args` → `input` |
| `post_tool_call`   | `toolEnd`       | `tool_call_id` → `toolId`                                             |
| `post_llm_call`    | `turnEnd`       | —                                                                     |
| `on_session_end`   | `sessionEnd`    | —                                                                     |
| `subagent_stop`    | ignored         | v1: Hermes subagent model differs from Claude's                       |

`normalizeHookEvent` returns `null` for any event not in the table above, and for `pre_tool_call` events missing `tool_call_id`.

## Tool Display and Animations

| Hermes tool    | `formatToolStatus` output | Animation |
| -------------- | ------------------------- | --------- |
| `terminal`     | `Running: <command>`      | typing    |
| `read_file`    | `Reading <filename>`      | reading   |
| `write_file`   | `Writing <filename>`      | typing    |
| `patch`        | `Editing <filename>`      | typing    |
| `search_files` | `Searching files`         | reading   |
| `browser`      | `Fetching web content`    | reading   |
| `process`      | `Running process`         | typing    |
| (default)      | `Using <toolName>`        | typing    |

`readingTools`: `read_file`, `search_files`, `browser`  
`permissionExemptTools`: `read_file`, `search_files`, `process`  
`subagentToolNames`: empty set (v1)  
`terminalNamePrefix`: `"hermes"` — used to detect VS Code integrated terminals running Hermes

## Hook Installer

`hermesHookInstaller.ts` manages entries in `~/.hermes/config.yaml` under the `hooks:` key.

### Install

Reads the file with `js-yaml`, merges pixel-agents entries for these 5 events:

```yaml
hooks:
  pre_tool_call:
    - command: 'node ~/.pixel-agents/hooks/hermes-hook.js'
      timeout: 10
  post_tool_call:
    - command: 'node ~/.pixel-agents/hooks/hermes-hook.js'
      timeout: 10
  post_llm_call:
    - command: 'node ~/.pixel-agents/hooks/hermes-hook.js'
      timeout: 10
  on_session_start:
    - command: 'node ~/.pixel-agents/hooks/hermes-hook.js'
      timeout: 10
  on_session_end:
    - command: 'node ~/.pixel-agents/hooks/hermes-hook.js'
      timeout: 10
```

Existing entries for other events are preserved. If a pixel-agents entry already exists for an event (detected by command path containing the hook script name), it is replaced rather than duplicated.

### Uninstall

Removes only entries whose `command` contains the hook script name. Leaves all other user entries intact.

### `areHooksInstalled`

Returns `true` if `config.yaml` exists and at least one of the 5 events has a pixel-agents entry.

### Error handling

- Missing `config.yaml`: creates it with just the `hooks:` block
- Malformed YAML: throws a descriptive error, does not overwrite the file
- Read/write failures: surfaces error to the caller (pixel-agents shows it in the UI)

## Hook Script (`hermes-hook.ts`)

Identical in structure to `claude-hook.ts`:

1. Reads full stdin as JSON
2. Reads `~/.pixel-agents/server.json` for `{ port, token }`
3. POSTs the raw payload to `http://127.0.0.1:<port>/hook/hermes` with `Authorization: Bearer <token>`
4. Exits 0 regardless of outcome (non-blocking, never delays Hermes)

Bundled by esbuild to `dist/hooks/hermes-hook.js` (CJS, Node 18+, shebang).

## Provider Registration

`server/src/providers/index.ts` gains one export line:

```ts
export { hermesProvider } from './hook/hermes/hermes.js';
```

The server's `hookEventHandler.ts` routes `POST /hook/hermes` to `hermesProvider.normalizeHookEvent` automatically, because the route is `/:providerId` and the handler looks up the provider by id.

## Hermes Consent

Hermes requires the user to approve new hook commands on first use (unless `hooks_auto_accept: true` is set in config). This is Hermes's native security model — pixel-agents does not bypass it. The first time a Hermes session runs after hooks are installed, Hermes will prompt once for approval. Subsequent sessions run silently.

## Dependencies

Add to `server/package.json`:

- `js-yaml` (runtime) — YAML read/write for config.yaml
- `@types/js-yaml` (devDependency) — TypeScript types
