import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DORMANT_PROJECTS_MAX } from './constants.js';
import type { DormantProject } from './types.js';

/** Read up to 8 KB of a JSONL file and extract the `cwd` field from the first SessionStart line. */
function extractCwdFromJsonl(jsonlPath: string): string | null {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8').slice(0, 8192);
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.hook_event_name === 'SessionStart' && typeof record.cwd === 'string') {
          return record.cwd;
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* file unreadable */
  }
  return null;
}

/**
 * Best-effort decode of a ~/.claude/projects dirname into a workspace path.
 * -Users-alice-myrepo → /Users/alice/myrepo
 * This is lossy (dots/hyphens in path components collapse), but serves as a
 * fallback when no JSONL is available.
 */
function decodeDirname(dirname: string): string {
  return dirname.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Scan ~/.claude/projects/ and return a merged list of DormantProject entries.
 * Preserves `skills` and `hidden` from existingProjects for known projectDirs.
 * Prunes entries whose projectDir no longer exists on disk.
 * Sorts by lastSeenAt descending; caps at DORMANT_PROJECTS_MAX.
 */
export async function scanDormantProjects(
  existingProjects: DormantProject[],
): Promise<DormantProject[]> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) {
    // Keep only entries whose projectDir still exists
    return existingProjects.filter((p) => fs.existsSync(p.projectDir));
  }

  let subdirNames: string[];
  try {
    subdirNames = fs.readdirSync(projectsRoot).filter((d) => {
      try {
        return fs.statSync(path.join(projectsRoot, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return existingProjects;
  }

  const existingMap = new Map(existingProjects.map((p) => [p.projectDir, p]));
  const discovered: DormantProject[] = [];

  for (const dirname of subdirNames) {
    const projectDir = path.join(projectsRoot, dirname);
    const existing = existingMap.get(projectDir);

    // Find most recently modified JSONL in this project dir
    let latestJsonl: { file: string; mtime: number } | null = null;
    try {
      const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
      for (const f of files) {
        const full = path.join(projectDir, f);
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (!latestJsonl || mtime > latestJsonl.mtime) {
            latestJsonl = { file: full, mtime };
          }
        } catch {
          /* ignore stat errors */
        }
      }
    } catch {
      /* no JSONL files or dir unreadable */
    }

    // Prefer cwd from JSONL; fall back to dirname decode
    const workspacePath =
      (latestJsonl ? extractCwdFromJsonl(latestJsonl.file) : null) ?? decodeDirname(dirname);
    const displayName = path.basename(workspacePath);

    discovered.push({
      projectDir,
      workspacePath,
      displayName,
      skills: existing?.skills ?? [],
      hidden: existing?.hidden ?? false,
      lastSeenAt: latestJsonl?.mtime,
    });
  }

  // Sort by lastSeenAt descending (undefined → treated as 0), cap at max
  return discovered
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .slice(0, DORMANT_PROJECTS_MAX);
}
