# CLAUDE_CONFIG_DIR support — design spec

**Date:** 2026-08-06
**Status:** Revised after Opus design review

## Problem

Claude Code CLI supports relocating its config directory away from the default
`~/.claude` via the `CLAUDE_CONFIG_DIR` environment variable (used for e.g.
running multiple accounts/profiles side by side). Pixel Agents does not know
about this: three files under `server/src/providers/hook/claude/` hardcode
`path.join(os.homedir(), '.claude', ...)` directly, five occurrences total:

| File | What it locates |
| --- | --- |
| `claude.ts:79,86` (`getSessionDirs`) | Session-dir lookup, plus its Windows case-insensitive fallback |
| `claude.ts:114` (`getAllSessionRoots`) | Root scanned by "Watch All Sessions" |
| `claudeHookInstaller.ts:29` (`getClaudeSettingsPath`) | Where hooks get installed/uninstalled (`settings.json`) |
| `claudeTeamProvider.ts:250` | Where team membership config (`teams/<name>/config.json`) is read |

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
  uninstall/reinstall hooks or reset live scanners mid-session. Exception:
  see S2 below — removing hooks from the *previous* location on change is a
  plain cleanup, not a live-reinstall, and can't safely be deferred.

### Non-goals

- No per-agent or multi-profile support (multiple different config dirs live
  at once).
- No live re-scan or scanner reset on setting change.
- No VS Code native `contributes.configuration` entry — this repo keeps
  settings of this shape (`hooksEnabled`, `watchAllSessions`,
  `externalAssetDirectories`, ...) in the webview Settings modal backed by
  shared `~/.pixel-agents/config.json`, not VS Code's native settings UI.
  `claudeConfigDir` follows that existing pattern.

## Design review findings addressed in this revision

An Opus review of the first draft caught three blockers and five should-fix
items, all verified against the actual code. This revision folds in the fix
for each:

| # | Finding | Fix applied in this revision |
| --- | --- | --- |
| B1 | VS Code boot-order claim was false — `installHooks()` fires from the constructor's `initServer()` at extension activation, before the first `readConfig()` call (which lived in the `webviewReady` handler, possibly minutes later or never) | §4: setter moved to the top of `PixelAgentsViewProvider`'s constructor |
| B2 | `CLAUDE_CONFIG_DIR` in a developer's real shell would defeat existing test isolation (`claudeHookInstaller.test.ts` mocks `os.homedir()` but not the env var; `claudeTeamProvider.test.ts` uses the real homedir already) | §6: `vi.stubEnv('CLAUDE_CONFIG_DIR', '')` added to every affected test file |
| B3 | "No e2e coverage" was wrong — the e2e suite isolates `~/.claude` via `HOME` redirection, and an inherited `CLAUDE_CONFIG_DIR` would silently break it | §6: `applyMockHomeEnv` strips the var; one new e2e scenario proves the override end-to-end |
| S1 | Second `settingsLoaded` emitter in `PixelAgentsViewProvider.ts` (hand-rolled, untyped) was missed | §3/§4: both emitters listed explicitly |
| S2 | Changing the directory orphans hooks in the old `settings.json` forever | §4: uninstall-from-old-path added as a synchronous part of handling the setting change |
| S3 | No validation on the typed path (`~` not expanded, relative paths, typos silently create the wrong directory) | §5: trim + expand `~` + absolute-path requirement + existence check surfaced in the UI |
| S4 | New handler case needs a payload type guard, matching every other case | §4: guard added |
| S5 | Both entrypoints reaching into the provider's internal files violates `providers/index.ts`'s own stated contract | §1/§4: re-exported through `providers/index.ts` |

Nits also folded in: constants moved to `constants.ts` (N1), header count
corrected to "five occurrences across three files" (N2), log lines print the
resolved path (N2), AsyncAPI mechanics spelled out explicitly (N3), UI shows
which source (setting vs. env vs. default) is active (N4).

## Design

### 1. Resolution

New constants in `server/src/providers/hook/claude/constants.ts`:

```ts
export const CLAUDE_CONFIG_DIR_NAME = '.claude';
export const CLAUDE_CONFIG_DIR_ENV_VAR = 'CLAUDE_CONFIG_DIR';
```

New file `server/src/providers/hook/claude/claudeConfigDir.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CLAUDE_CONFIG_DIR_ENV_VAR, CLAUDE_CONFIG_DIR_NAME } from './constants.js';

let override: string | undefined;

/** Set once at boot, before any provider function that touches ~/.claude runs. */
export function setClaudeConfigDirOverride(dir: string | undefined): void {
  override = dir?.trim() || undefined;
}

/** Resolves to: persisted override -> CLAUDE_CONFIG_DIR env var -> ~/.claude. */
export function getClaudeConfigDir(): string {
  return (
    override ||
    process.env[CLAUDE_CONFIG_DIR_ENV_VAR]?.trim() ||
    path.join(os.homedir(), CLAUDE_CONFIG_DIR_NAME)
  );
}

/** Which of the three sources is currently active, for display in the UI. */
export function getClaudeConfigDirSource(): 'setting' | 'env' | 'default' {
  if (override) return 'setting';
  if (process.env[CLAUDE_CONFIG_DIR_ENV_VAR]?.trim()) return 'env';
  return 'default';
}

/** Test-only: reset module state between test files. */
export function resetClaudeConfigDirOverrideForTests(): void {
  override = undefined;
}

/** Validates/normalizes settings-modal input (S3): '' clears the override;
 *  a leading `~` expands to this process's home dir; anything else must
 *  already be absolute. Returns null to signal "reject, don't persist". */
export function normalizeClaudeConfigDirInput(raw: string): string | null {
  if (raw === '') return '';
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? expanded : null;
}

/** The four settingsLoaded/claudeConfigDirUpdated fields, computed together
 *  so both server-side emitters (S1) stay in sync by construction.
 *
 *  `rawPersistedValue` is the caller's `readConfig().claudeConfigDir` —
 *  passed in rather than read here so this provider-internal module doesn't
 *  reach up into server-level config persistence. It deliberately does NOT
 *  feed back into `getClaudeConfigDir()`: per the restart-required decision,
 *  `resolved*` fields reflect the LIVE module override (set once at boot),
 *  which can legitimately differ from `claudeConfigDir` right after a save
 *  — that gap is what drives the "restart to apply" notice in the UI. */
export function buildClaudeConfigDirFields(rawPersistedValue: string): {
  claudeConfigDir: string;
  resolvedClaudeConfigDir: string;
  resolvedClaudeConfigDirSource: 'setting' | 'env' | 'default';
  resolvedClaudeConfigDirExists: boolean;
} {
  const resolvedClaudeConfigDir = getClaudeConfigDir();
  return {
    claudeConfigDir: rawPersistedValue,
    resolvedClaudeConfigDir,
    resolvedClaudeConfigDirSource: getClaudeConfigDirSource(),
    resolvedClaudeConfigDirExists: fs.existsSync(resolvedClaudeConfigDir),
  };
}
```

Precedence — persisted setting wins over the env var, which wins over the
default. This is a deliberate trade-off, not a default we didn't think
about: a persisted setting is a stickier, more explicit action (the user
typed it into the UI) than an env var that happens to be present in whatever
process launched Pixel Agents this time, and it's the only way the
settings-override half of this feature (VS Code extension hosts that don't
inherit shell env vars) can ever win. The risk — a stale persisted value
silently shadowing a deliberately-exported env var — is mitigated by
`getClaudeConfigDirSource()` making the active source visible in the UI (see
§5) rather than by changing the precedence.

This is module-level mutable state, set once at process boot, not threaded
as a parameter through the `HookProvider` interface. The four call sites are
free functions exported directly as the `HookProvider` object; adding a
parameter to each (and to the shared interface) is a much larger change for
something that changes at most once per process lifetime, consistent with
the "restart required" decision above. Verified safe: none of the three
provider files compute a `~/.claude` path at import time (all five
occurrences are inside function bodies), and `providers/index.ts` is a pure
re-export with no side effects — so there is no import-order hazard, only
the call-order hazard fixed in §4 (B1).

`providers/index.ts` re-exports the functions above (and `uninstallHooksAt`,
added in §4) alongside `claudeProvider`, so `cli.ts` and
`PixelAgentsViewProvider.ts` don't reach into the provider's internal
`claudeConfigDir.ts`/`claudeHookInstaller.ts` files directly (S5):

```ts
export { claudeProvider } from './hook/claude/claude.js';
export { copyHookScript, uninstallHooksAt } from './hook/claude/claudeHookInstaller.js';
export {
  setClaudeConfigDirOverride,
  getClaudeConfigDir,
  getClaudeConfigDirSource,
  normalizeClaudeConfigDirInput,
  buildClaudeConfigDirFields,
} from './hook/claude/claudeConfigDir.js';
```

Call sites updated to use `getClaudeConfigDir()` instead of
`path.join(os.homedir(), '.claude', ...)`:

- `claude.ts`: `getSessionDirs()` (both the primary and case-insensitive
  Windows fallback paths), `getAllSessionRoots()`
- `claudeHookInstaller.ts`: `getClaudeSettingsPath()`
- `claudeTeamProvider.ts`: the `teams/<teamName>/config.json` path

`~/.pixel-agents/*` paths (server discovery, hook script destination,
Pixel Agents' own state) are untouched — they're this project's own
namespace, unrelated to Claude Code's config dir.

Log lines in `claudeHookInstaller.ts` (`installHooks`/`uninstallHooks`,
currently hardcoded to print `~/.claude/settings.json`) are updated to print
`getClaudeSettingsPath()`'s actual resolved value, so a user with an
override set isn't misled by a log line that doesn't match reality.

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

- New `ClientMessage` variant, PascalCase schema name `SetClaudeConfigDir`
  (mirroring `AddExternalAssetDirectory`), with a `$ref` added to the
  `ClientMessage` `oneOf`:

  ```yaml
  SetClaudeConfigDir:
    type: object
    additionalProperties: false
    required: [type, claudeConfigDir]
    properties:
      type: { const: setClaudeConfigDir }
      claudeConfigDir: { type: string } # '' clears the override
  ```

- `settingsLoaded` (existing `ServerMessage`) gains four fields, added to
  both `required` and `properties`:
  - `claudeConfigDir: string` — the raw persisted override, i.e. what
    populates the settings text box.
  - `resolvedClaudeConfigDir: string` — what `getClaudeConfigDir()` resolves
    to *right now* on the server, computed fresh on every `webviewReady`.
    This lets the UI show the effective path even when the override field is
    blank and the value is actually coming from the env var.
  - `resolvedClaudeConfigDirSource: string` (`'setting' | 'env' | 'default'`)
    — which source is currently active, from `getClaudeConfigDirSource()`.
  - `resolvedClaudeConfigDirExists: boolean` — whether that resolved path
    exists on disk right now (`fs.existsSync`), so the UI can warn (§5)
    instead of letting a typo silently create an empty directory.
- New `ServerMessage` variant `claudeConfigDirUpdated`, sent in reply to
  `setClaudeConfigDir` so the webview refreshes immediately without waiting
  for the next `webviewReady` — same motivation as
  `externalAssetDirectoriesUpdated`. Carries the same four fields as the
  `settingsLoaded` additions above (all recomputed after the write), not
  just an echo of the raw value, since the resolved path/source/existence
  can all change as a result of the update:

  ```yaml
  ClaudeConfigDirUpdated:
    type: object
    additionalProperties: false
    required:
      [type, claudeConfigDir, resolvedClaudeConfigDir, resolvedClaudeConfigDirSource, resolvedClaudeConfigDirExists]
    properties:
      type: { const: claudeConfigDirUpdated }
      claudeConfigDir: { type: string }
      resolvedClaudeConfigDir: { type: string }
      resolvedClaudeConfigDirSource: { type: string }
      resolvedClaudeConfigDirExists: { type: boolean }
  ```

- New `ServerMessage` variant `claudeConfigDirRejected`, sent instead of
  `claudeConfigDirUpdated` when `normalizeClaudeConfigDirInput` (§1, S3)
  rejects the input as non-absolute, so the UI can show an inline error
  without guessing from a silently-unchanged `settingsLoaded`:

  ```yaml
  ClaudeConfigDirRejected:
    type: object
    additionalProperties: false
    required: [type, reason]
    properties:
      type: { const: claudeConfigDirRejected }
      reason: { const: not-absolute }
  ```

Regenerate `core/src/messages.ts` via `npm run asyncapi:generate` (CI enforces
zero diff). Because CI's drift check only catches the generated-file diff,
not runtime wiring, §4 explicitly enumerates every emitter and handler that
must be updated by hand.

### 4. Server-side wiring

**Both `settingsLoaded` emitters must be updated (S1):**
- `server/src/clientMessageHandler.ts`'s `handleWebviewReady` (WebSocket /
  standalone path)
- `adapters/vscode/PixelAgentsViewProvider.ts`'s hand-rolled `postMessage`
  call in the `webviewReady` branch (VS Code path) — this one is a raw
  object literal, not type-checked against the generated union, so it will
  not fail to compile if left out; it must be checked by hand.

Both get all four new fields added to their payload via
`buildClaudeConfigDirFields(readConfig().claudeConfigDir)` (defined in §1),
spread into the `send`/`postMessage` call. Pulling the four-field
computation into one shared helper — rather than duplicating it in both
emitters — is a direct fix for how S1 happened in the first place: the two
emitters drifting out of sync because one of them was hand-maintained.

**`clientMessageHandler.ts`: new `case 'setClaudeConfigDir'`** (S4: guarded
like every other case), mirroring `addExternalAssetDirectory`:

```ts
case 'setClaudeConfigDir': {
  const raw = typeof msg.claudeConfigDir === 'string' ? msg.claudeConfigDir.trim() : undefined;
  if (raw === undefined) break;
  // S3: expand ~ and reject non-absolute non-empty input (see §5) before it
  // ever reaches readConfig()/writeConfig() — validation lives here, not in
  // the webview, since only the server knows this process's home directory.
  const newDir = normalizeClaudeConfigDirInput(raw); // '' | absolute path, or reply with an error and break
  if (newDir === null) {
    send({ type: 'claudeConfigDirRejected', reason: 'not-absolute' });
    break;
  }
  const cfg = readConfig();
  const previousDir = getClaudeConfigDir(); // resolved value BEFORE the change
  cfg.claudeConfigDir = newDir;
  writeConfig(cfg);
  // S2: remove any hooks we previously installed at the old location — this is a
  // plain removal, not the live-reinstall declared a non-goal, and can't safely
  // wait for a restart or the old settings.json keeps firing hooks at us forever.
  if (previousDir !== newDir) {
    void uninstallHooksAt(previousDir);
  }
  send({ type: 'claudeConfigDirUpdated', ...buildClaudeConfigDirFields(newDir) });
  break;
}
```

Note `setClaudeConfigDirOverride()` is deliberately **not** called here —
per the restart-required decision, the live module override only changes at
boot, so `getClaudeConfigDir()` keeps resolving to the pre-edit value for
the rest of this process's life (that's exactly what makes
`resolvedClaudeConfigDir` in the reply legitimately differ from
`claudeConfigDir` and drives the "restart to apply" notice, §5).
`previousDir = getClaudeConfigDir()` — read *before* `writeConfig` — is
therefore "where hooks are installed right now", and the comparison against
`newDir` (not against a second `getClaudeConfigDir()` call, which would
always equal the first and never fire) is what actually detects a real
change worth cleaning up. `newDir === ''` is a valid case too: it falls
through to the env var or default, which may differ from `previousDir` just
as much as an explicit new path would.

`uninstallHooksAt(dir)` is a small addition to `claudeHookInstaller.ts`: the
existing `uninstallHooks()` logic parameterized by an explicit directory
instead of always calling `getClaudeConfigDir()` internally, exported
alongside it (and re-exported via `providers/index.ts`, S5) the same way
`copyHookScript` already is — a Claude-specific helper used directly by the
adapters, not part of the generic `HookProvider` interface, since no other
provider has an equivalent concept. `installHooks`/`areHooksInstalled` keep
using the ambient `getClaudeConfigDir()` as before; only this
cleanup-of-the-old-location path needs an explicit target.

VS Code adapter gets the equivalent case in its own message-handling switch,
same guard and same old-location cleanup.

**Boot order (B1 fix).** In `server/src/cli.ts`, the setter call slots in
right next to the existing earliest `readConfig()` call (the one that reads
`externalAssetDirectories` for the asset cache) — this placement was
correct in the original draft and is unchanged:

```ts
setClaudeConfigDirOverride(readConfig().claudeConfigDir);
```

In `adapters/vscode/PixelAgentsViewProvider.ts`, this must move to the
**first statement of the constructor**, immediately after `this.adapter =
adapter;` (line 106) — *before* `this.initServer()` is called at the end of
the constructor (line 169), which is what triggers `installHooks()`
asynchronously inside `pixelAgentsServer.start().then(...)`. The original
draft's claim that the earliest `readConfig()` call (inside the
`webviewReady` branch, line 411) was early enough is wrong: that branch only
runs once the panel is actually revealed, which can be well after
activation or never. Constructor placement guarantees the override is set
before any code path in the class can reach `installHooks()`.

### 5. UI

`SettingsModal.tsx` gains a labeled text input, same shape/pattern as the
external-asset-directory row:

- Value bound to `claudeConfigDir` (from `settingsLoaded`).
- On blur or an "Apply" button click, trim and send
  `{ type: 'setClaudeConfigDir', claudeConfigDir: <value> }`. Validation
  (S3: `~`-expansion, absolute-path requirement) is authoritative
  server-side (`normalizeClaudeConfigDirInput`, §1) rather than duplicated
  in the webview, since expanding `~` requires knowing the *server's* home
  directory — for the standalone CLI and the VS Code extension host that
  isn't necessarily the browser/webview's notion of "home" (standalone's
  webview runs in an ordinary browser tab). A `claudeConfigDirRejected`
  reply (§3) surfaces as an inline error instead of updating the resolved
  path/source display; a `claudeConfigDirUpdated` reply confirms success.
- Muted helper text underneath shows `resolvedClaudeConfigDir` and, per N4,
  which source produced it: `"Using ~/.claude (default)"` /
  `"Using $CLAUDE_CONFIG_DIR: /path"` / `"Using configured path: /path"`.
- If the input's current (unsaved or just-saved) value differs from
  `resolvedClaudeConfigDir`, show a small "restart Pixel Agents to apply"
  notice.
- If `resolvedClaudeConfigDir` does not exist on disk (server checks with
  `fs.existsSync` when building the `settingsLoaded` payload and adds a
  `resolvedClaudeConfigDirExists: boolean` field), show a warning inline
  rather than letting the directory get silently created empty by
  `writeClaudeSettings`'s `mkdirSync(..., {recursive:true})`.

`useExtensionMessages.ts` picks up the new `settingsLoaded` fields into
state, threaded down through `App.tsx` to `SettingsModal`, following the
same path as `externalAssetDirectories`.

### 6. Error handling

- Malformed/non-string `claudeConfigDir` in `config.json` (hand-edited or
  written by an older build): `readConfig()` defaults it to `''`, same as
  every other defensively-parsed field.
- Empty string clears the override — `getClaudeConfigDir()` falls through to
  the env var, then the default. No separate "unset" sentinel is needed.
- Non-absolute input is rejected at the settings-handler boundary (S3) rather
  than silently accepted and misresolved.
- No new failure modes in the session scanner / team provider — they already
  tolerate a nonexistent target directory (e.g. `getSessionDirs` already
  returns a path even if it doesn't exist yet, "caller tolerates missing
  dirs"); the new UI warning (§5) is about surfacing that state to the user,
  not about a code-level failure mode.

## Testing

**Unit (B2 fix — env-var test isolation):**

- New `server/__tests__/claudeConfigDir.test.ts`: precedence
  (override → env var → default), using `vi.stubEnv('CLAUDE_CONFIG_DIR', ...)`
  and `vi.mock('os', ...)` per the existing `claudeHookInstaller.test.ts`
  pattern, with `vi.unstubAllEnvs()` in `afterEach`.
- `server/__tests__/claudeHookInstaller.test.ts`: add
  `vi.stubEnv('CLAUDE_CONFIG_DIR', '')` + `resetClaudeConfigDirOverrideForTests()`
  to `beforeEach`, `vi.unstubAllEnvs()` to `afterEach`, so the existing
  `os.homedir()`-mocked isolation isn't defeated by an inherited env var on
  a developer machine that has one exported. Add cases for install/uninstall
  targeting an overridden path, and for `uninstallHooksAt(explicitDir)`.
- `server/__tests__/claudeTeamProvider.test.ts`: same env-stubbing addition
  (this file currently uses the *real* `os.homedir()`, making it more
  exposed to this hazard, not less) plus a case for the overridden path.
- `server/__tests__/configPersistence.test.ts` (existing or new): read/write
  round-trip and default-on-malformed-input for `claudeConfigDir`.

**E2E (B3 fix):**

- `e2e/helpers/mock-claude.ts`'s `applyMockHomeEnv` gets
  `delete env.CLAUDE_CONFIG_DIR;` added, the same way it already deletes
  `HOMEDRIVE`/`HOMEPATH` on Windows — this is the single choke point both
  the VS Code launch env (`launch.ts`) and the standalone launch env
  (`standalone.ts`) go through, so one fix covers both entrypoints. Without
  this, the whole suite would behave differently (and fail confusingly) on
  any CI runner or developer machine with `CLAUDE_CONFIG_DIR` exported.
- One new scenario (hooks-off or hooks-on, standalone or VS Code — whichever
  fits the existing lifecycle spec file best) that sets
  `CLAUDE_CONFIG_DIR=<tmpHome>/.claude-alt` in the mock-claude env and
  asserts the agent character still appears — this is the only test that
  proves the feature works end-to-end rather than proving string
  concatenation in isolation.

## Files touched

```
server/src/providers/hook/claude/claudeConfigDir.ts    (new)
server/src/providers/hook/claude/constants.ts
server/src/providers/hook/claude/claude.ts
server/src/providers/hook/claude/claudeHookInstaller.ts
server/src/providers/hook/claude/claudeTeamProvider.ts
server/src/providers/index.ts
server/src/configPersistence.ts
server/src/clientMessageHandler.ts
server/src/cli.ts
adapters/vscode/PixelAgentsViewProvider.ts
core/asyncapi.yaml
core/src/messages.ts                                    (generated)
webview-ui/src/components/SettingsModal.tsx
webview-ui/src/hooks/useExtensionMessages.ts
webview-ui/src/App.tsx
e2e/helpers/mock-claude.ts
server/__tests__/claudeConfigDir.test.ts                (new)
server/__tests__/claudeHookInstaller.test.ts
server/__tests__/claudeTeamProvider.test.ts
server/__tests__/configPersistence.test.ts
e2e/tests/claude/{hooks-on,hooks-off}/lifecycle.spec.ts  (one new scenario)
```
