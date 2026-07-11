import * as fs from 'node:fs';

import type { AgentStateStore } from './agentStateStore.js';

/**
 * Per-agent connection diagnostics. Structurally mirrors the `AgentDiagnostics`
 * shape consumed by the webview Debug View, so this payload drops straight into
 * the `agents` array of an `agentDiagnostics` ServerMessage.
 */
export interface AgentDiagnosticsEntry {
  id: number;
  projectDir: string;
  projectDirExists: boolean;
  jsonlFile: string;
  jsonlExists: boolean;
  fileSize: number;
  fileOffset: number;
  lastDataAt: number;
  linesProcessed: number;
}

/**
 * Build the connection-diagnostics payload for every agent in the store.
 *
 * Shared by the VS Code adapter and the standalone server so both surfaces emit
 * an identical `agentDiagnostics` payload. `jsonlExists` and `fileSize` are
 * coupled: both come from a single `fs.statSync` (the "has data but 0 lines"
 * Debug View branch depends on this), while `projectDirExists` is a separate
 * `fs.existsSync`. `lastDataAt === 0` is a meaningful "never" sentinel and is
 * forwarded as-is.
 */
export function buildAgentDiagnostics(store: AgentStateStore): AgentDiagnosticsEntry[] {
  const diagnostics: AgentDiagnosticsEntry[] = [];
  for (const agent of store.values()) {
    let jsonlExists = false;
    let fileSize = 0;
    try {
      const stat = fs.statSync(agent.jsonlFile);
      jsonlExists = true;
      fileSize = stat.size;
    } catch {
      /* file doesn't exist */
    }
    diagnostics.push({
      id: agent.id,
      projectDir: agent.projectDir,
      projectDirExists: fs.existsSync(agent.projectDir),
      jsonlFile: agent.jsonlFile,
      jsonlExists,
      fileSize,
      fileOffset: agent.fileOffset,
      lastDataAt: agent.lastDataAt,
      linesProcessed: agent.linesProcessed,
    });
  }
  return diagnostics;
}
