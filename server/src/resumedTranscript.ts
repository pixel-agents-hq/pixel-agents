/**
 * Following a /resume typed in a launched agent's terminal: the CLI moves on
 * to another session's transcript and nothing tells the office which, so both
 * surfaces' launches look for it here once the transcript they expected has
 * not appeared.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import { transcriptSuffix } from './directorySuggestions.js';

/**
 * The newest transcript in `projectDir` written since `since` that no agent
 * reads, or null: a file (never a folder: the CLI keeps `<sessionId>/` ones
 * beside its transcripts) whose name matches the provider's
 * `sessionFilePattern`. A provider that declares no pattern gets null: nothing
 * there tells its transcripts from anything else. Both surfaces' launches
 * follow a /resume with it.
 */
export function resumedTranscript(
  store: AgentStateStore,
  projectDir: string,
  since: number,
  sessionFilePattern: string | undefined,
): string | null {
  if (sessionFilePattern === undefined) return null;
  const suffix = transcriptSuffix(sessionFilePattern);
  const tracked = new Set([...store.values()].map((a) => path.resolve(a.jsonlFile)));
  let newest: { file: string; mtime: number } | null = null;
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
    const file = path.join(projectDir, entry.name);
    if (tracked.has(path.resolve(file))) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > since && (!newest || mtime > newest.mtime)) newest = { file, mtime };
  }
  return newest?.file ?? null;
}
