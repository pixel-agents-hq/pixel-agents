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

/** Test-only: reset module state between test files. */
export function resetClaudeConfigDirOverrideForTests(): void {
  override = undefined;
}
