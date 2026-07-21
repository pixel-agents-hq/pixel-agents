import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { getClaudeProjectDir } from './team';
import { narrate } from './test-narration';
import { clickAddAgent } from './webview';

const INTERNAL_AGENT_TIMEOUT_MS = 20_000;

export interface InternalAgentSpawn {
  sessionId: string;
  projectDir: string;
  jsonlFile: string;
  invocationLog: string;
}

function readInvocationLog(mockLogFile: string): string {
  try {
    return fs.readFileSync(mockLogFile, 'utf8');
  } catch {
    return '';
  }
}

function extractLatestSessionId(invocationLog: string): string | null {
  const matches = [...invocationLog.matchAll(/session-id=([^\s]+)/g)];
  return matches.length > 0 ? (matches[matches.length - 1]?.[1] ?? null) : null;
}

function countInvocations(invocationLog: string): number {
  return [...invocationLog.matchAll(/session-id=/g)].length;
}

function findJsonlFileForSession(tmpHome: string, sessionId: string): string | null {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return null;

    for (const entry of fs.readdirSync(projectsDir)) {
      const subdir = path.join(projectsDir, entry);
      try {
        if (!fs.statSync(subdir).isDirectory()) continue;
      } catch {
        continue;
      }

      const candidate = path.join(subdir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }

  return null;
}

export async function spawnInternalAgentAndWait(
  frame: Frame,
  tmpHome: string,
  mockLogFile: string,
): Promise<InternalAgentSpawn> {
  // Count invocations BEFORE clicking, then wait for a NEW one. Polling for a
  // merely non-empty log is satisfied instantly by a PRIOR agent's entry, so a
  // second spawn in the same test could read a stale log and return the first
  // agent's identity.
  const launchesBefore = countInvocations(readInvocationLog(mockLogFile));
  narrate.step('clicking "+ Agent" — a terminal launches the mock claude');
  await clickAddAgent(frame);

  await expect
    .poll(() => countInvocations(readInvocationLog(mockLogFile)), {
      message: `Expected mock invocation log at ${mockLogFile} to record launch #${launchesBefore + 1}`,
      timeout: INTERNAL_AGENT_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(launchesBefore);

  const invocationLog = readInvocationLog(mockLogFile);
  const sessionId = extractLatestSessionId(invocationLog);
  if (!sessionId) {
    throw new Error(`No session id found in mock invocation log at ${mockLogFile}`);
  }

  await expect
    .poll(() => findJsonlFileForSession(tmpHome, sessionId) ?? '', {
      message: `Expected a JSONL file for session ${sessionId} under ${tmpHome}`,
      timeout: INTERNAL_AGENT_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .not.toBe('');

  const jsonlFile = findJsonlFileForSession(tmpHome, sessionId);
  if (!jsonlFile) {
    throw new Error(`No JSONL file found for session ${sessionId}`);
  }

  narrate.check('mock claude launched with a --session-id and its JSONL exists');
  return {
    sessionId,
    projectDir: path.dirname(jsonlFile),
    jsonlFile,
    invocationLog,
  };
}

export async function spawnInternalAgentAndWaitForInvocation(
  frame: Frame,
  tmpHome: string,
  workspaceDir: string,
  mockLogFile: string,
): Promise<InternalAgentSpawn> {
  // Count invocations BEFORE clicking, then wait for a NEW one. Polling for a
  // merely non-empty log is satisfied instantly by a PRIOR agent's entry, so a
  // second spawn in the same test could read a stale log and return the first
  // agent's identity.
  const launchesBefore = countInvocations(readInvocationLog(mockLogFile));
  narrate.step('clicking "+ Agent" — a terminal launches the mock claude');
  await clickAddAgent(frame);

  await expect
    .poll(() => countInvocations(readInvocationLog(mockLogFile)), {
      message: `Expected mock invocation log at ${mockLogFile} to record launch #${launchesBefore + 1}`,
      timeout: INTERNAL_AGENT_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(launchesBefore);

  const invocationLog = readInvocationLog(mockLogFile);
  const sessionId = extractLatestSessionId(invocationLog);
  if (!sessionId) {
    throw new Error(`No session id found in mock invocation log at ${mockLogFile}`);
  }

  narrate.check('mock claude invoked with a fresh --session-id');
  const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
  return {
    sessionId,
    projectDir,
    jsonlFile: path.join(projectDir, `${sessionId}.jsonl`),
    invocationLog,
  };
}

/**
 * Spawn an agent bound to a specific workspace FOLDER in a multi-root window.
 * The plain "+ Agent" click opens a folder picker (BottomToolbar.tsx); we click
 * the named folder entry, which sends `launchAgent { folderPath }` so the agent
 * gets `folderName = <folder basename>` (adapters/vscode/agentManager.ts). Then
 * we wait for the spawn exactly like spawnInternalAgentAndWait. The seated
 * character surfaces via the getAgentSeats / getSeats test hooks (filter by
 * folderName), so callers correlate without an agent id here.
 */
export async function addAgentForFolder(
  frame: Frame,
  folderName: string,
  tmpHome: string,
  mockLogFile: string,
): Promise<InternalAgentSpawn> {
  const launchesBefore = countInvocations(readInvocationLog(mockLogFile));
  narrate.step(`clicking "+ Agent" and picking the "${folderName}" folder`);
  await frame.locator('button', { hasText: '+ Agent' }).click();
  // The folder-picker entries are <button> DropdownItems; scope to the button
  // role so we don't collide with the same folder name shown as a <span> in an
  // Area card's mapped-folders list (when the folder is already area-mapped).
  const folderItem = frame.getByRole('button', { name: folderName, exact: true });
  await expect(folderItem).toBeVisible({ timeout: INTERNAL_AGENT_TIMEOUT_MS });
  await folderItem.click();

  await expect
    .poll(() => countInvocations(readInvocationLog(mockLogFile)), {
      message: `Expected mock invocation log at ${mockLogFile} to record launch #${launchesBefore + 1}`,
      timeout: INTERNAL_AGENT_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(launchesBefore);

  const invocationLog = readInvocationLog(mockLogFile);
  const sessionId = extractLatestSessionId(invocationLog);
  if (!sessionId) {
    throw new Error(`No session id found in mock invocation log at ${mockLogFile}`);
  }

  await expect
    .poll(() => findJsonlFileForSession(tmpHome, sessionId) ?? '', {
      message: `Expected a JSONL file for session ${sessionId} under ${tmpHome}`,
      timeout: INTERNAL_AGENT_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .not.toBe('');

  const jsonlFile = findJsonlFileForSession(tmpHome, sessionId);
  if (!jsonlFile) {
    throw new Error(`No JSONL file found for session ${sessionId}`);
  }

  narrate.check(`agent for "${folderName}" launched — JSONL session created`);
  return { sessionId, projectDir: path.dirname(jsonlFile), jsonlFile, invocationLog };
}

export function createTranscriptStub(projectDir: string, sessionId: string): string {
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) {
    fs.writeFileSync(transcriptPath, '');
  }
  return transcriptPath;
}
