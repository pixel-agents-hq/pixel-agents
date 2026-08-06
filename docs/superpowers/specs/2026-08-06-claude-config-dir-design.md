# CLAUDE_CONFIG_DIR support — design spec

**Date:** 2026-08-06
**Status:** Revised after two rounds of Opus design review

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

## Second review round

A second Opus pass re-verified the first round's fixes against the actual
code (confirming exact line numbers) and caught issues in the fixes
themselves:

| # | Finding | Fix applied in this revision |
| --- | --- | --- |
| NEW-1 (blocker) | The `previousDir !== newDir` hook-cleanup trigger fires on *any* save of an empty field, even on a default install with nothing to clean up — because `newDir` (raw, possibly `''`) was compared directly against `previousDir` (always a resolved absolute path) instead of resolving `newDir` through the same precedence chain first | §1/§4: `resolveClaudeConfigDir(candidate)` extracted as the shared resolution primitive; the handler resolves `newDir` through it before comparing |
| NEW-2 (should-fix) | `resolvedClaudeConfigDirExists` in the `claudeConfigDirUpdated` reply describes the *old* (still-live) path, not the just-typed one, so a typo reports `exists: true` and warns nothing | §4/§5: reply also carries `pendingDirExists` computed against `newDir` directly, decoupled from the live-lagging `resolved*` fields |
| NEW-3 (blocker) | Agents Pixel Agents launches itself (`agentManager.ts`'s `vscode.window.createTerminal`) never receive `CLAUDE_CONFIG_DIR` in the terminal's environment — so the settings-override half of this feature (added specifically for VS Code hosts that don't inherit the shell's env var) leaves self-launched agents pointed at the wrong config dir while Pixel Agents watches the right one. This is the scenario the feature exists for | §4: new subsection, `createTerminal` gets an explicit `env` when an override is active |
| B3 (partial → resolved) | `applyMockHomeEnv` is not actually the single choke point — `e2e/helpers/standalone.ts` builds its spawn env inline and bypasses it; separately, the proposed "prove it end-to-end" e2e scenario can't work because `mock-claude-runner.cjs` hardcodes `.claude` path segments in multiple functions, so setting `CLAUDE_CONFIG_DIR` in the scenario env changes nothing the mock actually does | §6: `standalone.ts` routed through `applyMockHomeEnv` too (also de-duplicates it); the positive proof-of-override e2e scenario is dropped as disproportionate to this feature (rationale in §6) — unit coverage plus the protective env-stripping fix is the actual scope |
| S2 (partial → resolved) | `uninstallHooksAt` was introduced but `readClaudeSettings`/`writeClaudeSettings` — which it depends on — still resolved the path internally via the module-private `getClaudeSettingsPath()` with no way to target an explicit directory | §4: all three functions threaded with an optional explicit-dir parameter |
| S3 (partial → resolved) | `resolvedClaudeConfigDirExists`'s staleness (see NEW-2) undercut the validation story | Folded into the NEW-2 fix |
| NEW-4 (should-fix) | `reason: { const: not-absolute }` has no precedent in `core/asyncapi.yaml` — every existing `const` sits under a `type` discriminator property, and the closed-value-set precedent (`status`) uses `enum`, not `const`, on a non-`type` field | §3: changed to `reason: { type: string }`, unconstrained — avoids depending on untested Modelina behavior for a low-value constraint |
| NEW-5 (nit) | `uninstallHooksAt` alone doesn't cover the dependency chain | Same fix as S2 above |
| NEW-6 (nit) | `void uninstallHooksAt(previousDir)` implies a Promise the function doesn't return | §4: call made synchronous, no `void` |
| NEW-7 (nit) | `normalizeClaudeConfigDirInput` didn't handle Windows `~\`, didn't normalize `..`/trailing separators, and accepted a path pointing at an existing file | §1: `path.normalize`, `~\` handling, and an `fs.statSync` file-vs-directory check added |
| NEW-8 (nit) | "Files touched" omitted `agentManager.ts`, `standalone.ts`, and undercounted the e2e helper changes | §7: list corrected (and the dropped e2e scenario removed) |

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

/** Shared precedence chain: candidate override -> CLAUDE_CONFIG_DIR env var ->
 *  ~/.claude. Exported (not just used by getClaudeConfigDir) so callers can
 *  resolve a CANDIDATE value — e.g. "what would this resolve to if saved" —
 *  without mutating the live module override (NEW-1: comparing an unresolved
 *  candidate against an always-resolved value was the bug in the first cut
 *  of the hook-cleanup-on-change logic, §4). */
export function resolveClaudeConfigDir(candidate: string | undefined): string {
  return (
    candidate ||
    process.env[CLAUDE_CONFIG_DIR_ENV_VAR]?.trim() ||
    path.join(os.homedir(), CLAUDE_CONFIG_DIR_NAME)
  );
}

/** Resolves to: persisted override -> CLAUDE_CONFIG_DIR env var -> ~/.claude. */
export function getClaudeConfigDir(): string {
  return resolveClaudeConfigDir(override);
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
 *  a leading `~/` or `~\` expands to this process's home dir; the result is
 *  normalized (collapses `..` and trailing separators) and must be absolute;
 *  a path that already exists but isn't a directory is rejected. Returns
 *  null to signal "reject, don't persist" (NEW-7: Windows tilde form, `..`
 *  segments, and the file-vs-directory case were gaps in the first cut). */
export function normalizeClaudeConfigDirInput(raw: string): string | null {
  if (raw === '') return '';
  const homeExpanded =
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
      ? path.join(os.homedir(), raw.slice(1))
      : raw;
  const normalized = path.normalize(homeExpanded);
  if (!path.isAbsolute(normalized)) return null;
  if (fs.existsSync(normalized) && !fs.statSync(normalized).isDirectory()) return null;
  return normalized;
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
  resolveClaudeConfigDir,
  normalizeClaudeConfigDirInput,
  buildClaudeConfigDirFields,
} from './hook/claude/claudeConfigDir.js';
```

(`resolveClaudeConfigDir` must be included — §4's `setClaudeConfigDir` case
needs it directly, not just `getClaudeConfigDir()`. `resetClaudeConfigDirOverrideForTests`
is deliberately left out of this list: it's a test-only escape hatch, and
`server/__tests__/*.test.ts` files import it directly from
`claudeConfigDir.js` the same way `claudeHookInstaller.test.ts` already
imports internals directly — S5's "don't reach into provider internals"
concern is about production adapters, not test files.)

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
  `settingsLoaded` additions above (all recomputed after the write, still
  describing the *live* resolved dir — which legitimately still points at
  the pre-restart value, per §4), **plus** a fifth field,
  `pendingDirExists: boolean`, checked against `nextDir` — the value that
  *will* become active after a restart (§4's `resolveClaudeConfigDir(newDir
  || undefined)`, already computed for the hook-cleanup decision) — rather
  than the currently-lagging `resolvedClaudeConfigDir` (NEW-2: the first cut
  warned about the *old* path's existence, never the one the user just
  typed, which defeated the whole point of the check):

  ```yaml
  ClaudeConfigDirUpdated:
    type: object
    additionalProperties: false
    required:
      [type, claudeConfigDir, resolvedClaudeConfigDir, resolvedClaudeConfigDirSource, resolvedClaudeConfigDirExists, pendingDirExists]
    properties:
      type: { const: claudeConfigDirUpdated }
      claudeConfigDir: { type: string }
      resolvedClaudeConfigDir: { type: string }
      resolvedClaudeConfigDirSource: { type: string }
      resolvedClaudeConfigDirExists: { type: boolean }
      pendingDirExists: { type: boolean }
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
      reason: { type: string } # currently always 'not-absolute'; unconstrained
  ```

  `reason` is left as a plain `string` rather than `const`/`enum` (NEW-4):
  every existing `const` in the contract sits under a `type` discriminator,
  and the one precedent for a closed value set on a non-`type` field
  (`status`) uses `enum`. Constraining a single-value field here would be
  exercising an untested corner of the generator for a value the UI only
  ever branches on by string equality anyway — not worth the risk given CI
  hard-fails on any drift in the generated output.

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
  // NEW-1: resolve the candidate through the SAME precedence chain before
  // comparing — comparing the raw (possibly '') newDir against an
  // always-resolved previousDir made every save of an empty field look like
  // a change, even on a default install with nothing to clean up.
  const nextDir = resolveClaudeConfigDir(newDir || undefined);
  cfg.claudeConfigDir = newDir;
  writeConfig(cfg);
  // S2: remove any hooks we previously installed at the old location — this is a
  // plain removal, not the live-reinstall declared a non-goal, and can't safely
  // wait for a restart or the old settings.json keeps firing hooks at us forever.
  if (previousDir !== nextDir) {
    uninstallHooksAt(previousDir); // synchronous — see NEW-6
  }
  send({
    type: 'claudeConfigDirUpdated',
    ...buildClaudeConfigDirFields(newDir),
    pendingDirExists: fs.existsSync(nextDir), // NEW-2: check what WILL be active, not what still is
  });
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
"where hooks are installed right now"; `nextDir` is "where they'd resolve
to if the process restarted right now". Comparing those two (not `previousDir`
against the raw, possibly-empty `newDir`) is what makes the cleanup fire
exactly when the resolved location actually changes, including the case
where clearing an override (`newDir === ''`) happens to resolve back to the
same directory an active env var already pointed at (no-op, correctly).

`uninstallHooksAt(dir)` in `claudeHookInstaller.ts` needs more than a new
top-level function — `getClaudeSettingsPath()`, `readClaudeSettings()`, and
`writeClaudeSettings()` all currently resolve the path internally via the
module-private `getClaudeSettingsPath()` with no way to target a different
directory (S2/NEW-5). All three get an optional explicit-dir parameter,
defaulting to `getClaudeConfigDir()` so every other existing call site is
unaffected:

```ts
function getClaudeSettingsPath(dir: string = getClaudeConfigDir()): string {
  return path.join(dir, 'settings.json');
}
function readClaudeSettings(dir?: string): ClaudeSettings { /* uses getClaudeSettingsPath(dir) */ }
function writeClaudeSettings(settings: ClaudeSettings, dir?: string): void { /* uses getClaudeSettingsPath(dir) */ }

export function uninstallHooks(): void {
  uninstallHooksAt(getClaudeConfigDir());
}
export function uninstallHooksAt(dir: string): void {
  const settings = readClaudeSettings(dir);
  // ...same filtering logic uninstallHooks() has today...
  if (changed) writeClaudeSettings(settings, dir);
}
```

`uninstallHooksAt` is exported alongside the rest (and re-exported via
`providers/index.ts`, S5) the same way `copyHookScript` already is — a
Claude-specific helper used directly by the adapters, not part of the
generic `HookProvider` interface, since no other provider has an equivalent
concept. `installHooks`/`areHooksInstalled` keep using the ambient
`getClaudeConfigDir()` default as before; only the cleanup-of-the-old-location
path needs an explicit target. `uninstallHooks()`/`uninstallHooksAt()` are
synchronous (matching today's `uninstallHooks`), so the call in the handler
above isn't `void`-wrapped (NEW-6 — the first cut's `void` implied a Promise
that was never there).

VS Code adapter gets the equivalent case in its own message-handling switch,
same guard, same `resolveClaudeConfigDir`-based comparison, and same
old-location cleanup.

### 4b. Self-launched agents must inherit the override (NEW-3 fix)

The settings-override half of this feature exists specifically for the case
where the extension host's own process environment lacks `CLAUDE_CONFIG_DIR`
(§Scope: VS Code launched from Finder/Dock). But detection (hooks, session
scanning) is only half of what needs the right directory — `claude`
processes Pixel Agents **launches itself** need it too, or they write their
session/hook data to the wrong place while Pixel Agents watches the right
one, which is precisely the bug this feature exists to fix, just moved from
the read side to the write side.

`adapters/vscode/agentManager.ts`'s `launchNewTerminal` calls
`vscode.window.createTerminal({ name, cwd })` with no `env`, so the spawned
terminal (and the `claude` process typed into it via `sendText`) inherits
only the extension host's ambient environment. Fix: pass an explicit `env`
whenever an override is active, i.e. whenever
`getClaudeConfigDirSource() !== 'default'`:

```ts
const configDirSource = getClaudeConfigDirSource();
const terminal = vscode.window.createTerminal({
  name: `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`,
  cwd,
  env: configDirSource === 'default' ? undefined : { CLAUDE_CONFIG_DIR: getClaudeConfigDir() },
});
```

Passing it whenever the source isn't `'default'` (not only for `'setting'`)
is deliberately redundant in the `'env'` case — the extension host's own
env var would normally already flow through — but cheap insurance against
any environment-inheritance edge case between the extension host process
and a VS Code-spawned terminal.

The standalone CLI has no equivalent gap: it never launches `claude`
processes itself (there's no `launchAgent` handler in
`clientMessageHandler.ts` — the user runs `claude` in their own terminal,
where they're already responsible for their own environment), so no
standalone-side fix is needed here.

### 4c. Boot order (B1 fix)

In `server/src/cli.ts`, the setter call slots in
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
- Two distinct existence signals, not to be conflated: `resolvedClaudeConfigDirExists`
  (from `settingsLoaded`/`claudeConfigDirUpdated`) describes the *currently
  active* directory and drives a warning next to the "Using ..." helper text;
  `pendingDirExists` (from `claudeConfigDirUpdated` only, §3) describes the
  directory that will become active *after a restart* and drives a warning
  next to the "restart to apply" notice specifically — otherwise a typo'd
  save would show no warning until the user actually restarts and the wrong
  directory silently gets created by `writeClaudeSettings`'s
  `mkdirSync(..., {recursive:true})` on next hook install.

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
  (override → env var → default) via `resolveClaudeConfigDir`/`getClaudeConfigDir`,
  using `vi.stubEnv('CLAUDE_CONFIG_DIR', ...)` and `vi.mock('os', ...)` per
  the existing `claudeHookInstaller.test.ts` pattern, with
  `vi.unstubAllEnvs()` in `afterEach`; plus `normalizeClaudeConfigDirInput`
  cases (blank, `~/foo`, `~\foo` on Windows, `..`-containing paths, relative
  paths rejected, an existing-file path rejected, an existing-directory path
  accepted); plus `buildClaudeConfigDirFields` returning the raw value
  unchanged alongside the live-resolved fields.
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
- `server/__tests__/clientMessageHandler.test.ts`: new `setClaudeConfigDir`
  cases, explicitly including the regression this revision's own bug-fix
  (NEW-1) needs pinned down — saving `''` on an install with no override and
  no env var set must NOT call `uninstallHooksAt` (previously it would have,
  on every such save) — plus a case where the resolved directory genuinely
  changes and cleanup *does* fire, and a rejected-input case (non-absolute
  path → `claudeConfigDirRejected`, no write).

**E2E (B3 fix — protective only, see rationale below):**

- `e2e/helpers/mock-claude.ts`'s `applyMockHomeEnv` gets
  `delete env.CLAUDE_CONFIG_DIR;` added, the same way it already deletes
  `HOMEDRIVE`/`HOMEPATH` on Windows. The first cut of this fix assumed
  `applyMockHomeEnv` was the single choke point every launch env goes
  through — false: `e2e/helpers/standalone.ts:109-113` builds its spawn env
  inline (`{ ...process.env, HOME, USERPROFILE }`) and bypasses it entirely.
  Fixed by routing `standalone.ts` through `applyMockHomeEnv(process.env,
  args.homeDir)` instead of duplicating the object literal — this closes the
  gap *and* removes the duplication that let it open in the first place.
  Without this, the whole suite (both the VS Code and standalone halves)
  would behave differently, and fail confusingly, on any CI runner or
  developer machine with `CLAUDE_CONFIG_DIR` exported.

- **Dropped: a scenario proving the override works end-to-end.** The first
  cut proposed one, but `e2e/fixtures/mock-claude-runner.cjs` hardcodes
  `.claude` path segments directly in multiple functions (e.g.
  `ensureSessionContext`, `readSettings`) rather than deriving them from a
  configurable base — so setting `CLAUDE_CONFIG_DIR` in a scenario's env
  would change nothing about where the *mock* writes, and the scenario would
  prove nothing. Teaching the runner to honor the var would mean threading a
  configurable base directory through most of its file-path-building
  functions — a test-harness change disproportionate to this feature.
  Coverage of the resolution logic itself comes from the unit tests below
  (which exercise the real `getClaudeConfigDir`/`getSessionDirs`/etc.
  functions, not a mock); the e2e suite's job here is limited to "doesn't
  silently misbehave when the var happens to be set", which the protective
  fix above covers.

- No dedicated test for the `agentManager.ts` launch-env fix (§4b): the file
  has no existing Vitest coverage (it depends on the `vscode` module, like
  the rest of `adapters/vscode/`, which this repo doesn't unit-test), and
  adding e2e coverage would need the same runner change just ruled out
  above. This is a real coverage gap, called out rather than papered over —
  the existing VS Code e2e specs that launch agents via the panel button
  continue to pass as a regression check, but none of them assert on the
  terminal's environment specifically.

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
adapters/vscode/agentManager.ts
core/asyncapi.yaml
core/src/messages.ts                                    (generated)
webview-ui/src/components/SettingsModal.tsx
webview-ui/src/hooks/useExtensionMessages.ts
webview-ui/src/App.tsx
e2e/helpers/mock-claude.ts
e2e/helpers/standalone.ts
server/__tests__/claudeConfigDir.test.ts                (new)
server/__tests__/claudeHookInstaller.test.ts
server/__tests__/claudeTeamProvider.test.ts
server/__tests__/configPersistence.test.ts
server/__tests__/clientMessageHandler.test.ts
```
