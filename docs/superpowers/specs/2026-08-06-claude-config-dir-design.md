# CLAUDE_CONFIG_DIR support — design spec

**Date:** 2026-08-06
**Status:** Revised after three rounds of Opus design review, plus a scope
cut adopted after the third round (see "Third review round" below)

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
  uninstall/reinstall hooks or reset live scanners mid-session. This applies
  without exception, including cleanup of hooks left in the old location
  (S2/§4c): the original design tried to do that cleanup live, at save
  time; after two review rounds of edge cases it produced, it was moved to
  boot time instead — see "Third review round" below.

### Non-goals

- No per-agent or multi-profile support (multiple different config dirs live
  at once).
- No live re-scan or scanner reset on setting change.
- No VS Code native `contributes.configuration` entry — this repo keeps
  settings of this shape (`hooksEnabled`, `watchAllSessions`,
  `externalAssetDirectories`, ...) in the webview Settings modal backed by
  shared `~/.pixel-agents/config.json`, not VS Code's native settings UI.
  `claudeConfigDir` follows that existing pattern.
- No cross-process coordination between VS Code and standalone when both
  are running and one changes the setting — the other only picks up the
  change (hook cleanup + reinstall) on its own next restart, per §4c's
  residual cross-surface note. Building real coordination (e.g. a lock file,
  a live IPC signal between two otherwise-independent local processes) for
  a setting that's rarely changed and already requires a restart to take
  effect isn't worth it.
- No dedicated error-reporting protocol for settings-modal input that fails
  server-side validation after passing the client-side pre-check (§5) — it
  is silently dropped rather than surfaced with a `claudeConfigDirRejected`-style
  message, which was cut for being disproportionate to how rarely it would
  actually fire (see §3).

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

## Third review round

A third pass re-verified every code claim (all confirmed accurate — line
numbers, the `standalone.ts` bypass, the `mock-claude-runner.cjs` hardcoding)
and confirmed `vscode.TerminalOptions.env` **merges** with the inherited
environment rather than replacing it (only `strictEnv: true` would replace —
not used here), so the §4b terminal fix is API-safe. It found six should-fix
issues, none blocking, but its most consequential input was a direct
question: **is the design still proportionate after two rounds of patches?**

The answer was no, and the diagnosis was specific: **S2 (uninstall hooks
from the old location immediately, at save time) was the actual complexity
source** — it directly produced NEW-1 (the spurious-uninstall bug), NEW-5/S2's
own dependency-threading, NEW-6, most of §4's code, and a newly-surfaced
cross-surface race (VS Code and standalone sharing `claudeConfigDir` but
each running its own live override — whichever saves a change can uninstall
hooks the other process is still relying on, unaddressed until this pass).
The fix accepted, rather than another round of patching around it: **move
the cleanup from "immediately on save" to "at next boot, right before
installing at the new location"** — which fits the "restart required"
decision already made everywhere else in this spec, and removes the
live-trigger logic (and everything it caused) outright rather than hardening
it further. `claudeConfigDirRejected` was cut for the same reason: a whole
message variant to reject a non-absolute path, when light client-side
validation plus a silent server-side drop (matching how e.g.
`addExternalAssetDirectory` already handles a missing `path`) covers it for
free.

| # | Finding | Fix applied in this revision |
| --- | --- | --- |
| NEW-1 (re-verified) | Re-confirmed RESOLVED against same-path-resave, clear-with-env-set, and new-path cases — moot in this revision anyway since the live-trigger logic it patched no longer exists (see scope cut above) | §4c: cleanup moved to boot time |
| NEW-2 (partial) | `pendingDirExists` lived only on `claudeConfigDirUpdated`; a `settingsLoaded` fetched after an unrestarted change (e.g. reopening the panel) showed the restart notice with no existence warning | §1: folded into `buildClaudeConfigDirFields` as a fifth field, present on both messages by construction |
| NEW-3 (partial) | `env` semantics confirmed safe, but hardcoding `CLAUDE_CONFIG_DIR` directly in `adapters/vscode/agentManager.ts` violates "only the Claude provider knows Claude specifics" — and `buildLaunchCommand()`'s existing `env` return field is already the right seam, currently unused | §4b: env var moves into `claude.ts`'s `buildLaunchCommand`; `agentManager.ts` passes `launch.env` through instead of naming the var itself |
| should-fix 5 | VS Code's `setClaudeConfigDir` handling was described as "the equivalent case in its own switch" — ~25 lines of hand-duplicated logic, the same drift mechanism that caused S1 | §4: extracted into one shared `applySetClaudeConfigDir()`, called by both surfaces |
| should-fix 6 | Cross-surface race (two processes, one shared config field, two independent live overrides) | Resolved by the boot-time-cleanup scope cut — the residual risk (one surface's boot-time cleanup racing another surface's concurrent boot) is now rare and low-consequence enough to document rather than engineer around further (Non-goals) |
| nit | `getClaudeSettingsPath()` in a log line inside `uninstallHooksAt(dir)` needs the `dir` argument, not the no-arg default | §4c: fixed |
| nit | A third, untyped `settingsLoaded` emitter exists in `webview-ui/src/browserMock.ts` (dev-only browser mock) | Noted in §4 as an acknowledged, intentionally out-of-scope gap — it already tolerates missing fields |
| nit | `~\` handling in `normalizeClaudeConfigDirInput` isn't platform-gated | Left unconditional deliberately — a literal `~\` at the start of a path is not a realistic input on any platform, and a `process.platform` branch isn't worth the complexity for it |

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
 *  without mutating the live module override. (Originally added to compare
 *  candidates in a live hook-cleanup path that no longer exists — see
 *  "Third review round" — but still needed internally by
 *  buildClaudeConfigDirFields()'s pendingDirExists computation below.) */
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

/** The five settingsLoaded/claudeConfigDirUpdated fields, computed together
 *  so both server-side emitters (S1) — and both messages (NEW-2) — stay in
 *  sync by construction.
 *
 *  `rawPersistedValue` is the caller's `readConfig().claudeConfigDir` —
 *  passed in rather than read here so this provider-internal module doesn't
 *  reach up into server-level config persistence. `resolved*` deliberately
 *  reflects the LIVE module override (set once at boot), which can
 *  legitimately differ from `claudeConfigDir` right after a save — that gap
 *  is what drives the "restart to apply" notice in the UI. `pendingDirExists`
 *  is the complementary check: it resolves `rawPersistedValue` through the
 *  SAME precedence chain (without touching the live override) so it
 *  describes the directory that *will* be active after a restart, not the
 *  one that's active now — computed here rather than ad hoc at each call
 *  site so it can't drift out of sync with the other four fields the way it
 *  did in the previous revision (NEW-2). */
export function buildClaudeConfigDirFields(rawPersistedValue: string): {
  claudeConfigDir: string;
  resolvedClaudeConfigDir: string;
  resolvedClaudeConfigDirSource: 'setting' | 'env' | 'default';
  resolvedClaudeConfigDirExists: boolean;
  pendingDirExists: boolean;
} {
  const resolvedClaudeConfigDir = getClaudeConfigDir();
  const pendingDir = resolveClaudeConfigDir(rawPersistedValue || undefined);
  return {
    claudeConfigDir: rawPersistedValue,
    resolvedClaudeConfigDir,
    resolvedClaudeConfigDirSource: getClaudeConfigDirSource(),
    resolvedClaudeConfigDirExists: fs.existsSync(resolvedClaudeConfigDir),
    pendingDirExists: fs.existsSync(pendingDir),
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

`resolveClaudeConfigDir` is intentionally **not** re-exported here — after
the boot-time-cleanup scope cut (§4c), nothing outside `claudeConfigDir.ts`
calls it directly any more (it's used internally by `getClaudeConfigDir()`
and `buildClaudeConfigDirFields()`); the earlier revision needed it exported
for a live comparison in the message handler that no longer exists.
`resetClaudeConfigDirOverrideForTests` is deliberately left out of this list
too: it's a test-only escape hatch, and `server/__tests__/*.test.ts` files
import it directly from `claudeConfigDir.js` the same way
`claudeHookInstaller.test.ts` already imports internals directly — S5's
"don't reach into provider internals" concern is about production adapters,
not test files.

Call sites updated to use `getClaudeConfigDir()` instead of
`path.join(os.homedir(), '.claude', ...)`:

- `claude.ts`: `getSessionDirs()` (both the primary and case-insensitive
  Windows fallback paths), `getAllSessionRoots()`
- `claudeHookInstaller.ts`: `getClaudeSettingsPath()`
- `claudeTeamProvider.ts`: the `teams/<teamName>/config.json` path

`claude.ts`'s `buildLaunchCommand()` also gains a call to
`getClaudeConfigDirSource()`/`getClaudeConfigDir()` — not to relocate a
hardcoded path (it doesn't touch the filesystem), but to populate the
`env.CLAUDE_CONFIG_DIR` it returns when an override is active (§4b). This
needs two new imports in `claude.ts`: `getClaudeConfigDir`,
`getClaudeConfigDirSource` from `./claudeConfigDir.js`, and
`CLAUDE_CONFIG_DIR_ENV_VAR` folded into the existing `./constants.js`
import — both same-directory sibling imports, no circularity
(`claudeConfigDir.ts` imports only `fs`/`os`/`path`/`./constants.js`).

After this change, `os` becomes an unused import in `claude.ts` and
`claudeTeamProvider.ts` — both files' only other uses of `os.homedir()`
were the hardcoded paths this spec removes (§1's "Call sites updated"
list) — so both need the import dropped or `noUnusedLocals` fails the
build. `claudeHookInstaller.ts` keeps its `os` import (`getHookScriptPath()`
still uses it for `~/.pixel-agents/hooks/`, untouched by this feature).

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

`readConfig()` defensively parses `claudeConfigDir` (default `''` if
missing or non-string), `writeConfig()` persists it verbatim — same
treatment as `externalAssetDirectories`.

**`claudeConfigDirHooksInstalledAt` belongs on `AdapterSettings`, not here**
— a fourth-round review caught this: the field records "where did *this
surface's* last `installHooks()` call put things," which is per-process
state, not machine-wide state like `claudeConfigDir` genuinely is. Putting
it in the shared top-level shape (as an earlier revision did) meant VS Code
and standalone would read *each other's* record at boot and — since their
resolved directories can legitimately differ (that's the whole reason the
settings-override half of this feature exists) — each could call
`uninstallHooksAt` on a directory the *other* surface was actively relying
on, violating this codebase's own stated invariant ("Running both surfaces
in parallel never clobbers either") and regressing behavior that worked
before this feature existed. `hooksEnabled` already lives on
`AdapterSettings` for exactly this reason; this field follows the same
pattern:

```ts
export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  watchAllSessions: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
  claudeConfigDirHooksInstalledAt: string; // '' = this surface has never installed hooks (§4c)
}
```

Added to `ADAPTER_SETTING_KEYS`, `DEFAULT_ADAPTER_SETTINGS` (`''`), and
`parseAdapterSettings` (default `''` on missing/non-string), same as every
other field there. It exists solely to make the boot-time cleanup in §4c
possible without live cross-process tracking: it records the resolved
directory *this surface* installed hooks into last time *it* ran
`installHooks()`, so *its own* next boot can tell whether hooks might still
be sitting somewhere stale, without needing to compare against anything the
other surface did. It is never read or written outside that one boot-time
check, and never crosses the `vscode`/`standalone` boundary.

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

- `settingsLoaded` (existing `ServerMessage`) gains five fields, added to
  both `required` and `properties` — all five always computed together via
  `buildClaudeConfigDirFields()` (§1), never added piecemeal, which is what
  let one of them (`pendingDirExists`) go missing from this message in an
  earlier revision (NEW-2):
  - `claudeConfigDir: string` — the raw persisted override, i.e. what
    populates the settings text box.
  - `resolvedClaudeConfigDir: string` — what `getClaudeConfigDir()` resolves
    to *right now* on the server, computed fresh on every `webviewReady`.
    This lets the UI show the effective path even when the override field is
    blank and the value is actually coming from the env var.
  - `resolvedClaudeConfigDirSource: string` (`'setting' | 'env' | 'default'`)
    — which source is currently active, from `getClaudeConfigDirSource()`.
  - `resolvedClaudeConfigDirExists: boolean` — whether the *currently
    active* resolved path exists on disk right now, so the UI can warn (§5)
    next to the "Using ..." helper text.
  - `pendingDirExists: boolean` — whether the directory `claudeConfigDir`
    (the raw, possibly-just-saved value) would resolve to *after a
    restart* exists on disk, so the UI can warn next to the "restart to
    apply" notice specifically — decoupled from `resolvedClaudeConfigDirExists`
    so a typo is flagged even before restarting, not only after.
- New `ServerMessage` variant `claudeConfigDirUpdated`, sent in reply to
  `setClaudeConfigDir` so the webview refreshes immediately without waiting
  for the next `webviewReady` — same motivation as
  `externalAssetDirectoriesUpdated`. Carries exactly the same five fields,
  via the same `buildClaudeConfigDirFields()` call, recomputed after the
  write:

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

No `claudeConfigDirRejected` message: invalid input (non-absolute after
expansion, or an existing-file-not-directory) is silently dropped
server-side — no write, no reply — the same way e.g.
`addExternalAssetDirectory` already handles a missing `path` today (§4, §5).
A dedicated rejection message was in an earlier revision; cut for being a
whole new `ServerMessage` variant (and the AsyncAPI regen it entails) to
guard a case light client-side validation already prevents in the normal
path (§5).

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

(A third, untyped `settingsLoaded` emitter exists in
`webview-ui/src/browserMock.ts`, a dev-only mock used when developing the
webview outside a real server connection. It already tolerates missing
fields and isn't part of the shipped product path, so it's left out of
scope here rather than tracked as a third thing to keep in sync.)

Both real emitters get all five new fields added to their payload via
`buildClaudeConfigDirFields(readConfig().claudeConfigDir)` (defined in §1),
spread into the `send`/`postMessage` call. Pulling that computation into one
shared helper — rather than duplicating it in both emitters — is a direct
fix for how S1 happened in the first place: the two emitters drifting out of
sync because one of them was hand-maintained.

**`setClaudeConfigDir` handling is extracted into one shared function**,
`applySetClaudeConfigDir`, living in `clientMessageHandler.ts` (which
already imports `readConfig`/`writeConfig` and the provider functions) and
called directly by `adapters/vscode/PixelAgentsViewProvider.ts` — not
duplicated into a second hand-written copy the way the first two revisions
of this spec had it. That duplication was going to reproduce S1's exact
failure mode (two copies of non-trivial logic drifting apart) for no
reason: this handler has no host-specific behavior to justify two versions.

```ts
// clientMessageHandler.ts
export function applySetClaudeConfigDir(
  raw: unknown,
): ReturnType<typeof buildClaudeConfigDirFields> | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : undefined;
  if (trimmed === undefined) return null;
  // S3: expand ~ and reject non-absolute/non-directory input. Validation
  // lives here (not in the webview) because expanding ~ requires knowing
  // the SERVER's home directory — see §5 for why that can't be done
  // client-side. Invalid input is silently dropped: no write, no reply,
  // matching how addExternalAssetDirectory already handles a missing path.
  const newDir = normalizeClaudeConfigDirInput(trimmed);
  if (newDir === null) return null;
  const cfg = readConfig();
  cfg.claudeConfigDir = newDir;
  writeConfig(cfg);
  return buildClaudeConfigDirFields(newDir);
}
```

Callers just relay the result if non-null:

```ts
// clientMessageHandler.ts
case 'setClaudeConfigDir': {
  const fields = applySetClaudeConfigDir(msg.claudeConfigDir);
  if (fields) send({ type: 'claudeConfigDirUpdated', ...fields });
  break;
}
```

```ts
// adapters/vscode/PixelAgentsViewProvider.ts, in the existing if/else chain
} else if (message.type === 'setClaudeConfigDir') {
  const fields = applySetClaudeConfigDir(message.claudeConfigDir);
  if (fields) this.sendOrBuffer({ type: 'claudeConfigDirUpdated', ...fields });
}
```

Note this handler does **not** touch hooks at all — no uninstall, no
`setClaudeConfigDirOverride()` call. Per the restart-required decision, the
live module override only ever changes at boot (§4c), so saving a new value
here only ever writes `config.json`; `getClaudeConfigDir()` keeps resolving
to the pre-edit value for the rest of this process's life, which is exactly
what makes `resolvedClaudeConfigDir` in the reply legitimately differ from
`claudeConfigDir` and drives the "restart to apply" notice (§5). Cleanup of
whatever hooks were installed at the *old* location happens later, at the
next boot — see §4c — not here. (An earlier revision tried to do that
cleanup synchronously in this handler; it produced a spurious-uninstall bug
and a cross-surface race, documented in "Third review round" above, and was
removed rather than patched further.)

**`uninstallHooksAt(dir)` in `claudeHookInstaller.ts`** (used by §4c's
boot-time cleanup, below) needs more than a new top-level function —
`getClaudeSettingsPath()`, `readClaudeSettings()`, and `writeClaudeSettings()`
all currently resolve the path internally via the module-private
`getClaudeSettingsPath()` with no way to target a different directory
(S2/NEW-5). All three get an optional explicit-dir parameter, defaulting to
`getClaudeConfigDir()` so every other existing call site is unaffected:

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
  if (changed) writeClaudeSettings(settings, dir); // log line prints getClaudeSettingsPath(dir), not the no-arg default
}
```

`isOurHookEntry`/`makeHookEntry`/`makeHookCommand` do **not** need the dir
threaded through them — they all key off `getHookScriptPath()`, which
resolves under `~/.pixel-agents/hooks/` (this project's own namespace, left
alone per §1), and `isOurHookEntry` matches on the script filename marker,
independent of which Claude config dir it's found in.

`uninstallHooksAt` is exported alongside the rest (and re-exported via
`providers/index.ts`, S5) the same way `copyHookScript` already is — a
Claude-specific helper used directly by callers outside the provider, not
part of the generic `HookProvider` interface, since no other provider has
an equivalent concept. `installHooks`/`areHooksInstalled` keep using the
ambient `getClaudeConfigDir()` default as before; only the
cleanup-of-the-old-location path needs an explicit target.
`uninstallHooks()`/`uninstallHooksAt()` are synchronous (matching today's
`uninstallHooks`) — no `void` wrapping needed at call sites (NEW-6).

### 4b. Self-launched agents must inherit the override (NEW-3 fix)

The settings-override half of this feature exists specifically for the case
where the extension host's own process environment lacks `CLAUDE_CONFIG_DIR`
(§Scope: VS Code launched from Finder/Dock). But detection (hooks, session
scanning) is only half of what needs the right directory — `claude`
processes Pixel Agents **launches itself** need it too, or they write their
session/hook data to the wrong place while Pixel Agents watches the right
one, which is precisely the bug this feature exists to fix, just moved from
the read side to the write side.

The fix belongs in the Claude provider, not the adapter: `claude.ts`'s
`buildLaunchCommand()` already returns an `env` field
(`HookProvider`'s launch-command contract exists for exactly this kind of
thing), but `adapters/vscode/agentManager.ts` currently ignores it entirely
— `env` is computed (`{ PWD: cwd }`) and never used. Fixing this in
`agentManager.ts` by naming `CLAUDE_CONFIG_DIR` directly there would put
Claude-specific knowledge in the one layer that's supposed to stay
Claude-agnostic (CLAUDE.md: "the Claude provider is the only place that
knows Claude specifics"); using the existing `env` field instead fixes the
gap *and* the layering *and* the dead field in one move.

`buildLaunchCommand()` gains the var when an override is active:

```ts
// claude.ts
function buildLaunchCommand(
  sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  const args = ['--session-id', sessionId];
  if (opts?.bypassPermissions) args.push('--dangerously-skip-permissions');
  const env: Record<string, string> = { PWD: cwd };
  if (getClaudeConfigDirSource() !== 'default') {
    env[CLAUDE_CONFIG_DIR_ENV_VAR] = getClaudeConfigDir();
  }
  return { command: 'claude', args, env };
}
```

`agentManager.ts`'s `launchNewTerminal` passes `launch.env` through to
`vscode.window.createTerminal`, which requires calling `buildLaunchCommand`
*before* `createTerminal` rather than after (today's order, reversed here
since `createTerminal` now needs `launch.env`). `buildLaunchCommand` needs
`sessionId`, currently generated (`crypto.randomUUID()`) after
`createTerminal` today, so that line moves up too — the reorder isn't just
the two calls in isolation:

```ts
const sessionId = crypto.randomUUID(); // moved above createTerminal — buildLaunchCommand needs it
const launch = claudeProvider.buildLaunchCommand?.(sessionId, cwd, { bypassPermissions });
if (!launch) throw new Error('claudeProvider.buildLaunchCommand is not implemented');
const terminal = vscode.window.createTerminal({
  name: `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`,
  cwd,
  env: launch.env,
});
```

`vscode.TerminalOptions.env` **merges** with the terminal's inherited
environment by default (it only replaces it if `strictEnv: true` is also
passed, which this doesn't) — confirmed against the VS Code API before
relying on it, since a replacing merge would have broken every other
environment variable the terminal needs. Passing `env.PWD` through as a
side effect of using the field at all is harmless (redundant with `cwd`,
which already sets the shell's working directory).

Passing `CLAUDE_CONFIG_DIR` whenever the source isn't `'default'` (not only
for `'setting'`) is deliberately redundant in the `'env'` case — the
extension host's own env var would normally already flow through to the
terminal via the merge above — but is cheap insurance against any
environment-inheritance edge case between the extension host process and a
VS Code-spawned terminal.

The standalone CLI has no equivalent gap: it never launches `claude`
processes itself (there's no `launchAgent` handler in
`clientMessageHandler.ts` — the user runs `claude` in their own terminal,
where they're already responsible for their own environment), so no
standalone-side fix is needed here.

### 4c. Boot sequence: override, then stale-hook cleanup, then install (B1 + S2 fix)

Both entrypoints need three things to happen in order, every boot. Rather
than each entrypoint hand-rolling this sequence (the S1/should-fix-5 drift
risk again), it's two exported functions in a new shared module,
`server/src/claudeConfigDirBoot.ts`, imported by both `cli.ts` and
`adapters/vscode/PixelAgentsViewProvider.ts` — this one lives at the server
level rather than inside the provider directory because, like
`applySetClaudeConfigDir`, it needs `readConfig`/`writeConfig` directly:

```ts
// server/src/claudeConfigDirBoot.ts

/** 1: set the live override. 2: if THIS SURFACE's hooks might still be
 *  sitting in a DIFFERENT directory than the one that's now resolved,
 *  remove them from there — cheap no-op if there's nothing to clean up.
 *  Call once, as early as possible in boot, before any code path can reach
 *  installHooks(). `namespace` scopes the installed-at record to this
 *  surface only (vscode vs standalone) — see §2's per-namespace rationale. */
export function prepareClaudeConfigDirForBoot(namespace: ConfigNamespace): void {
  const cfg = readConfig();
  setClaudeConfigDirOverride(cfg.claudeConfigDir || undefined);
  const resolvedDir = getClaudeConfigDir();
  const installedAt = cfg[namespace].claudeConfigDirHooksInstalledAt;
  if (installedAt && installedAt !== resolvedDir) {
    uninstallHooksAt(installedAt);
  }
}

/** 3: record where THIS SURFACE's hooks now live, once installHooks() has
 *  actually succeeded. Call from EVERY installHooks() call site on this
 *  surface, not just boot — see the toggle-path note below. */
export function recordClaudeConfigDirHooksInstalled(namespace: ConfigNamespace): void {
  const cfg = readConfig(); // re-read: installHooks() is async, something
  cfg[namespace].claudeConfigDirHooksInstalledAt = getClaudeConfigDir(); // else may have written config.json meanwhile
  writeConfig(cfg);
}
```

`recordClaudeConfigDirHooksInstalled()` re-reads `config.json` rather than
reusing whatever `prepareClaudeConfigDirForBoot()` already had in scope,
since `installHooks()` is async and other code may run — and may itself
write `config.json` — in between; re-reading avoids clobbering a concurrent
write.

**Every `installHooks()` call site on a surface must call
`recordClaudeConfigDirHooksInstalled(namespace)` right after, not only the
boot-time one.** Each surface has two: boot (`cli.ts:204`,
`PixelAgentsViewProvider.ts:214`) and the Settings-modal hooks-enabled
toggle (`cli.ts:131`, `PixelAgentsViewProvider.ts:307`). Missing the toggle
path reopens the exact bug §4c exists to fix: boot with hooks off (record
stays `''`) → toggle hooks on (installs at dir A, unrecorded) → user changes
`claudeConfigDir` → next boot's cleanup check sees a falsy record and skips
it → dir A's hooks are orphaned forever. `cli.ts`'s boot call is `await`ed,
so recording after it is straightforwardly correct; VS Code's boot call
(`void claudeProvider.installHooks(...)`, not awaited) records eagerly
right after the `void` call rather than chaining onto the promise —
deliberately, since the failure mode of recording slightly early (before
the write actually lands) only costs a harmless no-op `uninstallHooksAt`
on a future boot, not a correctness bug.

This replaces the live per-save cleanup an earlier revision attempted (see
"Third review round"): the check now runs once, at a point where "the
resolved directory" is completely unambiguous (nothing else is running
yet), rather than mid-session where the live override, the just-saved raw
value, and hooks another process installed can all be in different states
at once.

**Placement — this is where B1 actually lived**, and the fix from the first
review round is unchanged by the S2 rework: in `server/src/cli.ts`,
`prepareClaudeConfigDirForBoot('standalone')` slots in right next to the
existing earliest `readConfig()` call (the one that reads
`externalAssetDirectories` for the asset cache). In
`adapters/vscode/PixelAgentsViewProvider.ts`,
`prepareClaudeConfigDirForBoot('vscode')` must run as the **first statement
of the constructor**, immediately after `this.adapter = adapter;` (line
106) — *before* `this.initServer()` is called at the end of the constructor
(line 169), which is what triggers `installHooks()` asynchronously inside
`pixelAgentsServer.start().then(...)`. The original draft's claim that the
earliest `readConfig()` call (inside the `webviewReady` branch, line 411)
was early enough is wrong: that branch only runs once the panel is actually
revealed, which can be well after activation or never. Constructor
placement guarantees the override — and the stale-hook cleanup — happen
before any code path in the class can reach `installHooks()`.

**Residual cross-surface note.** With `claudeConfigDirHooksInstalledAt`
namespaced (§2), the cross-surface race an earlier revision of this section
had is gone by construction — each surface only ever compares against, and
cleans up, its own record; it's structurally unable to touch hooks the
other surface installed. What's left is much smaller: if both surfaces
happen to resolve to the *same* directory (the common case — most users
don't run divergent `CLAUDE_CONFIG_DIR` values per surface) and one surface
changes `claudeConfigDir` (the shared setting) while both are running, only
that surface's *next restart* re-resolves and re-installs; the other
surface keeps running against whatever it already has until it too
restarts. That's a staleness window bounded by "until you restart the other
surface," not a clobbering risk — accepted as a known limitation rather
than engineered around further (Non-goals).

### 5. UI

`SettingsModal.tsx` gains a labeled text input, styled like the
external-asset-directory row but **unconditional**, not gated behind
`isBrowserRuntime` the way that row is (`SettingsModal.tsx:116-138` renders
a native-picker `MenuItem` instead of a text input in VS Code). This field
needs the same text-input UI on both surfaces — VS Code is, if anything,
the primary motivating case (§Scope: extension hosts that don't inherit
shell env vars), so hiding it there the way the asset-directory row does
would defeat the point.

- Value bound to `claudeConfigDir` (from `settingsLoaded`).
- Light client-side pre-check before sending at all: blank, or starts with
  `/` or `~` (a cheap heuristic, not full validation — it exists so an
  obviously-wrong value like a relative path gets an immediate inline error
  without a round trip). On blur or an "Apply" button click, if the
  pre-check passes, trim and send
  `{ type: 'setClaudeConfigDir', claudeConfigDir: <value> }`.
- The pre-check is deliberately not the authoritative validation —
  `normalizeClaudeConfigDirInput` (§1, S3) is, and it runs server-side,
  since expanding a leading `~` requires knowing the *server's* home
  directory, which for the standalone CLI is not the browser tab the
  webview runs in, and for VS Code is not necessarily the webview iframe's
  notion of anything either. If input somehow reaches the server invalid
  despite passing the client pre-check (e.g. it resolves to an existing
  file, which the client can't check at all), it's silently dropped — no
  write, no reply (§3, §4) — so the UI simply doesn't see a
  `claudeConfigDirUpdated` confirmation for that save. This is an accepted,
  documented gap (no dedicated error protocol for it) rather than a
  motivation to build one; see §3's rationale for cutting
  `claudeConfigDirRejected`.
- A `claudeConfigDirUpdated` reply confirms success and refreshes the
  helper text/warnings below immediately.
- Muted helper text underneath shows `resolvedClaudeConfigDir` and, per N4,
  which source produced it: `"Using ~/.claude (default)"` /
  `"Using $CLAUDE_CONFIG_DIR: /path"` / `"Using configured path: /path"`.
- If the input's current (unsaved or just-saved) value differs from
  `resolvedClaudeConfigDir`, show a small "restart Pixel Agents to apply"
  notice.
- Two distinct existence signals, not to be conflated, both present on
  *both* `settingsLoaded` and `claudeConfigDirUpdated` (§3) since both come
  from the same `buildClaudeConfigDirFields()` call: `resolvedClaudeConfigDirExists`
  describes the *currently active* directory and drives a warning next to
  the "Using ..." helper text; `pendingDirExists` describes the directory
  that will become active *after a restart* and drives a warning next to
  the "restart to apply" notice specifically — otherwise a typo'd save
  would show no warning until the user actually restarts and the wrong
  directory silently gets created by `writeClaudeSettings`'s
  `mkdirSync(..., {recursive:true})` on next hook install. Because both
  fields are present on `settingsLoaded` too, this warning survives a panel
  reload between saving and restarting, not just the immediate reply.

`useExtensionMessages.ts` picks up the new `settingsLoaded` fields into
state, threaded down through `App.tsx` to `SettingsModal`, following the
same path as `externalAssetDirectories`.

### 6. Error handling

- Malformed/non-string `claudeConfigDir` in `config.json` (hand-edited or
  written by an older build): `readConfig()` defaults it to `''`, same as
  every other defensively-parsed field.
- Empty string clears the override — `getClaudeConfigDir()` falls through to
  the env var, then the default. No separate "unset" sentinel is needed.
- Non-absolute (or existing-file) input is rejected at the settings-handler
  boundary (S3) rather than silently accepted and misresolved — but the
  rejection itself is silent (no reply message, §3), relying on the
  client-side pre-check (§5) to catch the common cases before they're ever
  sent.
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
  accepted); plus `buildClaudeConfigDirFields` returning all five fields
  consistently, including `pendingDirExists` resolving the raw value through
  the same precedence chain independent of the live override.
- `server/__tests__/claude.test.ts`: `getSessionDirs()`/`getAllSessionRoots()`
  respect override → env var → default precedence; `buildLaunchCommand()`
  includes `env.CLAUDE_CONFIG_DIR` when the source isn't `'default'` and
  omits it otherwise (§4b) — same env-stubbing additions as the other files
  in this list, since this file also calls `os.homedir()`.
- `server/__tests__/claudeHookInstaller.test.ts`: add
  `vi.stubEnv('CLAUDE_CONFIG_DIR', '')` + `resetClaudeConfigDirOverrideForTests()`
  to `beforeEach`, `vi.unstubAllEnvs()` to `afterEach`, so the existing
  `os.homedir()`-mocked isolation isn't defeated by an inherited env var on
  a developer machine that has one exported. Add cases for install/uninstall
  targeting an overridden path, and for `uninstallHooksAt(explicitDir)`
  (including that it's a no-op, not an error, when nothing is installed at
  `explicitDir`).
- `server/__tests__/claudeTeamProvider.test.ts`: same env-stubbing addition
  (this file currently uses the *real* `os.homedir()`, making it more
  exposed to this hazard, not less) plus a case for the overridden path.
- `server/__tests__/configPersistence.test.ts` (existing or new): read/write
  round-trip and default-on-malformed-input for the shared `claudeConfigDir`
  field, and for `claudeConfigDirHooksInstalledAt` on `AdapterSettings` —
  including that `vscode` and `standalone` track it independently (setting
  one namespace's doesn't touch the other's).
- `server/__tests__/clientMessageHandler.test.ts`: new `setClaudeConfigDir`
  cases against `applySetClaudeConfigDir` directly — a valid absolute path
  persists and returns the five fields; blank persists and clears; a
  non-absolute or existing-file input returns `null` and performs no write.
  No live-uninstall case needed here any more (S2's cleanup moved to boot
  time, below) — this handler now only ever touches `config.json`.
- New `server/__tests__/claudeConfigDirBoot.test.ts`: `prepareClaudeConfigDirForBoot(namespace)`
  — no-op when that namespace's `claudeConfigDirHooksInstalledAt` is unset
  or already matches the resolved dir; calls `uninstallHooksAt` exactly once
  when they differ; explicitly does NOT fire based on the *other*
  namespace's record (the cross-surface fix — set `vscode`'s record to
  something stale, call `prepareClaudeConfigDirForBoot('standalone')`,
  assert no uninstall). `recordClaudeConfigDirHooksInstalled(namespace)` —
  writes the currently-resolved dir into only that namespace. Together: a
  same-path resave never triggers cleanup; a genuine override change does,
  exactly once, at the next boot, for the surface that actually changed.

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
server/src/claudeConfigDirBoot.ts                       (new)
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
server/__tests__/claude.test.ts
server/__tests__/claudeConfigDir.test.ts                (new)
server/__tests__/claudeConfigDirBoot.test.ts             (new)
server/__tests__/claudeHookInstaller.test.ts
server/__tests__/claudeTeamProvider.test.ts
server/__tests__/configPersistence.test.ts
server/__tests__/clientMessageHandler.test.ts
```
