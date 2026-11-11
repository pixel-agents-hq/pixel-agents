import * as fs from 'fs';
import * as path from 'path';

/**
 * Canonical key for a filesystem path used as a Map/Set key or compared for identity.
 *
 * The same JSONL transcript reaches the runtime through two producers that spell it
 * differently on Windows:
 *
 *  - hooks carry `transcript_path` derived from Claude's own `process.cwd()`
 *    (`...\projects\C--Users-me-project\<id>.jsonl`)
 *  - the scanners build paths from the workspace folder VS Code reports, and
 *    `Uri.fsPath` lowercases the drive letter
 *    (`...\projects\c--Users-me-project\<id>.jsonl`)
 *
 * Windows resolves both to the same file, so `readdirSync` happily returns entries
 * under either spelling — but `Map`/`Set` lookups are exact-string and miss, which
 * previously let dismissed files be re-adopted and let one session spawn two agents.
 */
export function toPathKey(p: string): string {
  if (!p) return p;
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when both paths point at the same file/directory (case-insensitive on Windows). */
export function pathsMatch(left: string, right: string): boolean {
  return toPathKey(left) === toPathKey(right);
}

/**
 * A path with its symlinks resolved, as far as the disk goes: the realpath of
 * its deepest existing ancestor, with the rest appended. So a folder that is
 * gone (a parked Worktree) still resolves through a symlinked Directory, the
 * way it did while it existed.
 */
export function realPath(p: string): string {
  const resolved = path.resolve(p);
  const rest: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** {@link toPathKey} of {@link realPath}: one key for every spelling of a folder. */
export function realPathKey(p: string): string {
  return toPathKey(realPath(p));
}

/**
 * Whether two paths name the same file or folder, however spelled: the same
 * path (case-insensitive on Windows), or the same once symlinks are resolved
 * (a Directory reached through a link, a hook naming the resolved folder).
 * The one comparison for Worktree folders. Undefined only equals undefined.
 */
export function sameFolder(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return pathsMatch(a, b) || realPathKey(a) === realPathKey(b);
}

/** Whether anything is at `p` (a dangling symlink counts: it is something). */
export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set of filesystem paths that normalizes every entry through {@link toPathKey}, so
 * membership survives the spelling differences described above. Drop-in for
 * `Set<string>`: callers keep passing raw paths to `add`/`has`/`delete`.
 *
 * Iteration yields canonical keys, not the original spellings — nothing reads entries
 * back out today, so keep it that way rather than reintroducing a raw-path round-trip.
 */
export class PathSet extends Set<string> {
  override add(value: string): this {
    return super.add(toPathKey(value));
  }

  override has(value: string): boolean {
    return super.has(toPathKey(value));
  }

  override delete(value: string): boolean {
    return super.delete(toPathKey(value));
  }
}
