# CLAUDE_CONFIG_DIR support — design spec

**Date:** 2026-08-06
**Status:** Draft, pending review

## Problem

Claude Code CLI supports relocating its config directory away from the default
`~/.claude` via the `CLAUDE_CONFIG_DIR` environment variable (used for e.g.
running multiple accounts/profiles side by side). Pixel Agents does not know
about this: four locations across the Claude provider hardcode
`path.join(os.homedir(), '.claude', ...)` directly:

| File | What it locates |
| --- | --- |
| `server/src/providers/hook/claude/claude.ts` (`getSessionDirs`, `getAllSessionRoots`) | Where `.jsonl` session transcripts are scanned from |
| `server/src/providers/hook/claude/claudeHookInstaller.ts` (`getClaudeSettingsPath`) | Where hooks get installed/uninstalled (`settings.json`) |
| `server/src/providers/hook/claude/claudeTeamProvider.ts` | Where team membership config (`teams/<name>/config.json`) is read |

If a user runs Claude Code with `CLAUDE_CONFIG_DIR` set, Pixel Agents silently
keeps looking at `~/.claude`: hooks get installed in the wrong file, session
transcripts are never found, and the agent character for that session never
appears.

A grep across the repo confirms zero existing handling of `CLAUDE_CONFIG_DIR`
or any equivalent override, and no open GitHub issue tracks this specifically
(#377 "Clobbers agent settings files" is adjacent — an unsafe write to
`~/.claude/settings.json` — but is about safety of the write, not about the
path being unconfigurable).

## Scope

Confirmed with the user:

- **Single value, not per-session/multi-profile.** The user runs Pixel
  Agents' own process (VS Code extension host or standalone CLI) with
  `CLAUDE_CONFIG_DIR` already set in its environment — not different values
  per `claude` terminal. One resolved directory per Pixel Agents process is
  sufficient.
- **Env var + explicit settings override**, not env var alone. VS Code's
  extension host frequently doesn't inherit shell-only env vars (e.g. when
  VS Code is launched from Finder/Dock rather than a terminal that exported
  the var), so a settings-level fallback is needed for that case even though
  the user's own current setup uses the env var successfully.
- **Restart required to apply**, not live-apply. Changing the value only
  persists it and surfaces a "restart to apply" notice — it does not
  uninstall/reinstall hooks or reset live scanners mid-session.

### Non-goals

- No per-agent or multi-profile support (multiple different config dirs live
  at once).
- No live-apply (hook reinstall, scanner restart) on setting change.
- No VS Code native `contributes.configuration` entry — this repo keeps
  settings of this shape (`hooksEnabled`, `watchAllSessions`,
  `externalAssetDirectories`, ...) in the webview Settings modal backed by
  shared `~/.pixel-agents/config.json`, not VS Code's native settings UI.
  `claudeConfigDir` follows that existing pattern.

## Design

### 1. Resolution

New file `server/src/providers/hook/claude/claudeConfigDir.ts`:

```ts
import * as os from 'os';
import * as path from 'path';

let override: string | undefined;

/** Set once at boot, before any provider function that touches ~/.claude runs. */
export function setClaudeConfigDirOverride(dir: string | undefined): void {
  override = dir?.trim() || undefined;
}

/** Resolves to: persisted override -> CLAUDE_CONFIG_DIR env var -> ~/.claude. */
export function getClaudeConfigDir(): string {
  return override || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/** Test-only: reset module state between test files. */
export function resetClaudeConfigDirOverrideForTests(): void {
  override = undefined;
}
```

Precedence — persisted setting wins over the env var, which wins over the
default — matches the more-explicit-wins convention used elsewhere in the
codebase and mirrors upstream Claude Code CLI's own resolution for the env
var/default half.

This is module-level mutable state, set once at process boot, not threaded
as a parameter through the `HookProvider` interface. The four call sites are
free functions exported directly as the `HookProvider` object; adding a
parameter to each (and to the shared interface) is a much larger change for
something that changes at most once per process lifetime, consistent with
the "restart required" decision above.

Call sites updated to use `getClaudeConfigDir()` instead of
`path.join(os.homedir(), '.claude', ...)`:

- `claude.ts`: `getSessionDirs()` (both the primary and case-insensitive
  Windows fallback paths), `getAllSessionRoots()`
- `claudeHookInstaller.ts`: `getClaudeSettingsPath()`
- `claudeTeamProvider.ts`: the `teams/<teamName>/config.json` path

`~/.pixel-agents/*` paths (server discovery, hook script destination,
Pixel Agents' own state) are untouched — they're this project's own
namespace, unrelated to Claude Code's config dir.

### 2. Persistence

`configPersistence.ts` gains a shared top-level field, alongside
`externalAssetDirectories` (not per-namespace — this describes the machine,
not a per-surface UI preference):

```ts
export interface PixelAgentsConfig {
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
  claudeConfigDir: string; // '' = unset; falls through to env var / default
}
```

`readConfig()` defensively parses it (default `''` if missing or
non-string), `writeConfig()` persists it verbatim — same treatment as
`externalAssetDirectories`.

### 3. Protocol (AsyncAPI)

`core/asyncapi.yaml` changes:

- New `ClientMessage` variant:

  ```yaml
  setClaudeConfigDir:
    type: object
    additionalProperties: false
    required: [type, claudeConfigDir]
    properties:
      type: { const: setClaudeConfigDir }
      claudeConfigDir: { type: string } # '' clears the override
  ```

- `settingsLoaded` (existing `ServerMessage`) gains two fields:
  - `claudeConfigDir: string` — the raw persisted override, i.e. what
    populates the settings text box.
  - `resolvedClaudeConfigDir: string` — what `getClaudeConfigDir()` resolves
    to *right now* on the server, computed fresh on every `webviewReady`.
    This lets the UI show the effective path even when the override field is
    blank and the value is actually coming from the env var — otherwise a
    user with the env var set but no override would see an empty box and no
    confirmation anything is working.

Regenerate `core/src/messages.ts` via `npm run asyncapi:generate` (CI enforces
zero diff).

### 4. Server-side wiring

`clientMessageHandler.ts`: new `case 'setClaudeConfigDir'`, mirroring
`addExternalAssetDirectory` — read config, set `cfg.claudeConfigDir`, write
config. No runtime side effect (no hook reinstall, no scanner reset) per the
restart-required decision.

`handleWebviewReady`: `settingsLoaded` payload gains
`claudeConfigDir: cfg.claudeConfigDir` and
`resolvedClaudeConfigDir: getClaudeConfigDir()`.

Boot order — both `cli.ts` and `PixelAgentsViewProvider.ts` must call

```ts
setClaudeConfigDirOverride(readConfig().claudeConfigDir);
```

before the first use of anything in the Claude provider that touches
`~/.claude` (`claudeProvider.installHooks(...)`, `AgentRuntime`
construction, session scanning). In both entrypoints this slots in right
next to the existing earliest `readConfig()` call (the one that reads
`externalAssetDirectories` for the asset cache), so it's set before
anything else runs.

### 5. UI

`SettingsModal.tsx` gains a labeled text input, same shape/pattern as the
external-asset-directory row:

- Value bound to `claudeConfigDir` (from `settingsLoaded`).
- On blur or an "Apply" button click, sends
  `{ type: 'setClaudeConfigDir', claudeConfigDir: <trimmed value> }`.
- Muted helper text underneath shows `resolvedClaudeConfigDir` (what's
  actually active right now).
- If the input's current (unsaved or just-saved) value differs from
  `resolvedClaudeConfigDir`, show a small "restart Pixel Agents to apply"
  notice.

`useExtensionMessages.ts` picks up `claudeConfigDir` and
`resolvedClaudeConfigDir` from `settingsLoaded` into state, threaded down
through `App.tsx` to `SettingsModal`, following the same path as
`externalAssetDirectories`.

### 6. Error handling

- Malformed/non-string `claudeConfigDir` in `config.json` (hand-edited or
  written by an older build): `readConfig()` defaults it to `''`, same as
  every other defensively-parsed field.
- Empty string clears the override — `getClaudeConfigDir()` falls through to
  the env var, then the default. No separate "unset" sentinel is needed.
- No new failure modes in the hook installer / session scanner / team
  provider — they already tolerate a nonexistent target directory (e.g.
  `getSessionDirs` already returns a path even if it doesn't exist yet,
  "caller tolerates missing dirs").

## Testing

- `server/__tests__/claude.test.ts`: `getSessionDirs` / `getAllSessionRoots`
  respect override → env var → default precedence (three cases each).
- `server/__tests__/claudeHookInstaller.test.ts`: install/uninstall target
  the overridden path when set.
- `server/__tests__/claudeTeamProvider.test.ts`: team config path honors the
  override.
- `server/__tests__/configPersistence.test.ts` (existing or new): read/write
  round-trip and default-on-malformed-input for `claudeConfigDir`.
- No e2e coverage: mock-claude scenarios don't exercise real `~/.claude`
  paths, so this stays out of that suite's scope, consistent with how the
  existing hardcoded-path logic isn't e2e-tested today either.

## Files touched

```
server/src/providers/hook/claude/claudeConfigDir.ts   (new)
server/src/providers/hook/claude/claude.ts
server/src/providers/hook/claude/claudeHookInstaller.ts
server/src/providers/hook/claude/claudeTeamProvider.ts
server/src/configPersistence.ts
server/src/clientMessageHandler.ts
server/src/cli.ts
adapters/vscode/PixelAgentsViewProvider.ts
core/asyncapi.yaml
core/src/messages.ts                                   (generated)
webview-ui/src/components/SettingsModal.tsx
webview-ui/src/hooks/useExtensionMessages.ts
webview-ui/src/App.tsx
server/__tests__/claude.test.ts
server/__tests__/claudeHookInstaller.test.ts
server/__tests__/claudeTeamProvider.test.ts
server/__tests__/configPersistence.test.ts
```
