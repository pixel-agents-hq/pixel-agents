/**
 * Whether a command resolves on PATH, the way a shell would find it (PATHEXT
 * on Windows). Used to tell whether a provider's CLI is installed at all.
 */

import * as fs from 'fs';
import * as path from 'path';

export function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (platform === 'win32') return true;
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
}
