/**
 * Optional native PTY module loader.
 *
 * node-pty is a native module, which is a real problem for `npx pixel-agents`.
 * Two independent failure modes exist in the wild (both measured -- see
 * docs/design/standalone-terminal.md):
 *
 * 1. The module isn't installed at all (optionalDependency install failed, or
 *    the platform has no prebuilt binary). `require()` throws.
 * 2. The module IS installed and imports cleanly, but every spawn throws.
 *    npm >=11.16 gates lifecycle scripts by default, so official node-pty's
 *    post-install chmod of its `spawn-helper` binary never runs, and the first
 *    spawn dies with `posix_spawnp failed`.
 *
 * Case 2 is why availability is established by ACTUALLY SPAWNING a throwaway PTY
 * rather than by a successful import. A `try { require } catch` would report the
 * terminal as available and then break on the user's first keystroke.
 */

import { PTY_MODULE_CANDIDATES } from '../constants.js';

/** The slice of node-pty's surface this project uses. Structural, so any
 *  API-compatible fork (official node-pty, @lydell/node-pty) satisfies it. */
export interface IPty {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): IPty;
}

/** Outcome of resolving a PTY implementation. */
export interface PtyModuleResolution {
  /** The loaded module, or null when no candidate could be used. */
  module: PtyModule | null;
  /** Module id that satisfied the request (diagnostics only). */
  moduleId: string | null;
  /** Human-readable reason the terminal is unavailable; null when available.
   *  Surfaced verbatim in the server log and in the browser drawer. */
  reason: string | null;
}

/**
 * Require a module by id at runtime without esbuild rewriting or bundling it.
 *
 * The CLI is bundled as CJS with the PTY candidates marked external, so a plain
 * `require(id)` would already be left alone -- but the id here is a variable, and
 * keeping the indirection explicit documents that this MUST stay a runtime lookup:
 * bundling a native module is not possible, and resolution failure is a normal,
 * expected outcome rather than a build error.
 */
function requireAtRuntime(id: string): unknown {
  const req: NodeRequire = require;
  return req(id);
}

function isPtyModule(value: unknown): value is PtyModule {
  return typeof (value as PtyModule | null)?.spawn === 'function';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load the first usable PTY module and verify it can actually spawn.
 *
 * Not cached here -- PtySessionManager owns the caching, so this stays a pure,
 * directly testable function.
 */
export function resolvePtyModule(
  candidates: readonly string[] = PTY_MODULE_CANDIDATES,
): PtyModuleResolution {
  const failures: string[] = [];

  for (const id of candidates) {
    let loaded: unknown;
    try {
      loaded = requireAtRuntime(id);
    } catch (err) {
      failures.push(`${id}: ${describeError(err)}`);
      continue;
    }

    if (!isPtyModule(loaded)) {
      failures.push(`${id}: loaded but exposes no spawn()`);
      continue;
    }

    // Windows: a successful import is the whole test. The spawn probe exists
    // for the POSIX-only failure mode where npm's script gating skips the
    // spawn-helper chmod (case 2 above) — ConPTY has no helper binary, so
    // there is no import-succeeds-spawn-fails mode to probe for. The probe is
    // also a hazard there: spawning a ConPTY and killing it immediately races
    // the conpty agent's socket connect and can intermittently crash the whole
    // process (observed as standalone hosts dying at boot on Windows CI).
    const spawnError = process.platform === 'win32' ? null : probeSpawn(loaded);
    if (spawnError) {
      // The npm-script-gating case lands here: imported fine, cannot spawn.
      failures.push(`${id}: loaded but cannot spawn (${spawnError})`);
      continue;
    }

    return { module: loaded, moduleId: id, reason: null };
  }

  const reason =
    failures.length > 0
      ? `No working PTY module. Tried -- ${failures.join('; ')}`
      : 'No PTY module candidates configured.';
  return { module: null, moduleId: null, reason };
}

/**
 * Spawn a trivial PTY and immediately kill it. Returns an error string when the
 * module is present but non-functional, or null when it works.
 */
function probeSpawn(mod: PtyModule): string | null {
  let probe: IPty | null = null;
  try {
    probe = mod.spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', [], {
      name: 'dumb',
      cols: 1,
      rows: 1,
      cwd: process.cwd(),
      env: {},
    });
    return null;
  } catch (err) {
    return describeError(err);
  } finally {
    try {
      probe?.kill();
    } catch {
      // Probe teardown is best-effort: a PTY that spawned but won't die on
      // request still proves spawning works, which is all we asked it.
    }
  }
}
