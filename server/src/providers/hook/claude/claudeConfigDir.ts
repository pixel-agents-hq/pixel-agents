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
 *  resolve a CANDIDATE value -- e.g. "what would this resolve to if saved" --
 *  without mutating the live module override. Used internally by
 *  buildClaudeConfigDirFields()'s pendingDirExists computation. */
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

/** Test-only: reset module state between test files.
 *  @internal -- exported for tests only; not part of the module's API. */
export function resetClaudeConfigDirOverrideForTests(): void {
  override = undefined;
}

/** Validates/normalizes settings-modal input: '' clears the override; a
 *  leading `~/` or `~\` expands to this process's home dir; the result is
 *  normalized (collapses `..` and trailing separators) and must be
 *  absolute; a path that already exists but isn't a directory is rejected.
 *  Returns null to signal "reject, don't persist". */
export function normalizeClaudeConfigDirInput(raw: string): string | null {
  if (raw === '') return '';
  const homeExpanded =
    raw === '~'
      ? os.homedir()
      : raw.startsWith('~/') || raw.startsWith('~\\')
        ? path.join(os.homedir(), raw.slice(2))
        : raw;
  const normalized = path.normalize(homeExpanded);
  if (!path.isAbsolute(normalized)) return null;
  if (fs.existsSync(normalized) && !fs.statSync(normalized).isDirectory()) return null;
  return normalized;
}

/** The five settingsLoaded/claudeConfigDirUpdated fields, computed together
 *  so both server-side emitters -- and both messages -- stay in sync by
 *  construction.
 *
 *  `rawPersistedValue` is the caller's `readConfig().claudeConfigDir` --
 *  passed in rather than read here so this provider-internal module doesn't
 *  reach up into server-level config persistence. `resolved*` reflects the
 *  LIVE module override (set once at boot), which can legitimately differ
 *  from `claudeConfigDir` right after a save -- that gap is what drives the
 *  "restart to apply" notice in the UI. `pendingDirExists` resolves
 *  `rawPersistedValue` through the SAME precedence chain (without touching
 *  the live override) so it describes the directory that WILL be active
 *  after a restart, not the one that's active now. */
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
