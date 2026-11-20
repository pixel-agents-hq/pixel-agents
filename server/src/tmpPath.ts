import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * A sibling temp name for an atomic tmp + rename write of `filePath`, unique to
 * this write. The files under ~/.pixel-agents/ (and ~/.claude/settings.json)
 * are shared by every VS Code window and the standalone server: with one fixed
 * `<file>.tmp`, two writers truncate each other's tmp, one rename commits the
 * other's content while reporting success, and the second fails with ENOENT.
 */
export function uniqueTmpPath(filePath: string, suffix = '.tmp'): string {
  return `${filePath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}${suffix}`;
}

/** Best-effort removal of a failed write's tmp file: a leftover we cannot
 *  remove must never mask the error the caller is already handling. */
export function removeTmp(tmpPath: string): void {
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    /* ignore */
  }
}
