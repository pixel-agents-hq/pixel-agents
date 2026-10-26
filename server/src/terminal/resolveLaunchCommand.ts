/**
 * Resolve a provider's launch command to something node-pty can actually spawn.
 *
 * Why this exists: @lydell/node-pty (and official node-pty) on Windows do NOT
 * search PATH for bare command names — `spawn('claude', …)` throws
 * `Error: File not found: ` with an EMPTY path, which reads as a mystery
 * (measured on this repo's own win32-x64 prebuild: bare `node` throws the
 * same way while an absolute path spawns fine). Providers return bare names
 * (`claude`, `hermes`) because that is what a VS Code terminal would resolve
 * shell-agnostically; the standalone PTY must resolve them first.
 *
 * POSIX is a pass-through: there `posix_spawnp` does PATH resolution inside
 * node-pty itself, so resolving here would only add a shadowing difference.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedCommand {
  command: string;
  args: string[];
}

/** Extension order for a bare name. .exe is spawned directly; .cmd/.bat must
 *  go through cmd.exe (CreateProcess cannot launch a batch file itself). */
const DIRECT_EXTS = ['.exe', '.com'];
const BATCH_EXTS = ['.cmd', '.bat'];

function scanPathDirs(envPath: string | undefined): string[] {
  if (!envPath) return [];
  return envPath.split(path.delimiter).filter(Boolean);
}

/**
 * Returns an absolute, spawnable command (possibly rewriting a batch hit into
 * `cmd.exe /d /c <file> …`), or throws with an actionable message when the
 * provider CLI is nowhere on PATH. Idempotent for already-absolute/relative
 * paths (those are left for the PTY to error on with a real reason).
 */
export function resolveLaunchCommand(
  command: string,
  args: string[],
  opts: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
  } = {},
): ResolvedCommand {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'win32') return { command, args };

  // Anything with a separator is an explicit path: pass through untouched.
  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
    return { command, args };
  }

  const dirs = scanPathDirs(env.PATH ?? env.Path);
  const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((e) => e.toLowerCase())
    .filter(Boolean);
  // Bare-name hit first only if some PATH entry literally holds a file named
  // `command` with no extension and it is executable-shaped; standard Windows
  // tooling always carries an extension, so scan extension lists instead.
  const wanted = [...DIRECT_EXTS, ...BATCH_EXTS].filter((e) => exts.includes(e));

  for (const dir of dirs) {
    for (const ext of wanted) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          if (DIRECT_EXTS.includes(ext)) return { command: candidate, args };
          const shell = env.COMSPEC && env.COMSPEC.trim() ? env.COMSPEC : 'cmd.exe';
          // /d skips AutoRun hooks; /c runs the batch and exits.
          return { command: shell, args: ['/d', '/c', candidate, ...args] };
        }
      } catch {
        /* not here: next PATH entry */
      }
    }
  }

  throw new Error(
    `'${command}' was not found on PATH. Install the CLI for this provider, or point the office at a ` +
      `machine where it is available. (Windows-only: the PTY cannot spawn bare command names.)`,
  );
}
