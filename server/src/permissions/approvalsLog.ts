import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import type { ApprovalLogEntry } from './approvalRegistry.js';
import { APPROVALS_LOG_FILE_NAME } from './constants.js';

/** ~/.pixel-agents/approvals.log, resolved per call (HOME can differ in tests). */
export function approvalsLogPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, APPROVALS_LOG_FILE_NAME);
}

/** Tabs and newlines would split a field or a line; the fields are free text. */
function field(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/** One tab-separated line: time, decision, agent, repo, tool, client, detail. */
export function formatApprovalLogLine(entry: ApprovalLogEntry): string {
  return (
    [
      entry.time,
      entry.decision,
      `agent=${entry.agentId}`,
      `repo=${field(entry.repo)}`,
      `tool=${field(entry.tool)}`,
      `client=${field(entry.client ?? '?')}`,
      `detail=${field(entry.detail)}`,
    ].join('\t') + '\n'
  );
}

/** Append one answer to the audit log. Never throws: a full disk must not
 *  turn an answer the user already gave into an error. Created 0600 (the
 *  details are commands and file contents). */
export function appendApprovalLog(entry: ApprovalLogEntry, filePath = approvalsLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, formatApprovalLogLine(entry), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error('[Pixel Agents] Failed to write approvals.log:', err);
  }
}
