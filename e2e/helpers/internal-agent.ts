import { expect } from '@playwright/test';
import type { Frame } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { getClaudeProjectDir } from './team';
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
  await clickAddAgent(frame);

  await expect
    .poll(() => extractLatestSessionId(readInvocationLog(mockLogFile)) ?? '', {
      message: `Expected mock invocation log at ${mockLogFile} to contain a session id`,
      timeout: INTERNAL_AGENT_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .not.toBe('');

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
  await clickAddAgent(frame);

  await expect
    .poll(() => extractLatestSessionId(readInvocationLog(mockLogFile)) ?? '', {
      message: `Expected mock invocation log at ${mockLogFile} to contain a session id`,
      timeout: INTERNAL_AGENT_TIMEOUT_MS,
      intervals: [250, 500, 1000],
    })
    .not.toBe('');

  const invocationLog = readInvocationLog(mockLogFile);
  const sessionId = extractLatestSessionId(invocationLog);
  if (!sessionId) {
    throw new Error(`No session id found in mock invocation log at ${mockLogFile}`);
  }

  const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
  return {
    sessionId,
    projectDir,
    jsonlFile: path.join(projectDir, `${sessionId}.jsonl`),
    invocationLog,
  };
}

export function createTranscriptStub(projectDir: string, sessionId: string): string {
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) {
    fs.writeFileSync(transcriptPath, '');
  }
  return transcriptPath;
}
