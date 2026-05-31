import fs from 'fs';
import path from 'path';

export interface HookServerConfig {
  port: number;
  pid: number;
  token: string;
  startedAt: number;
}

export interface HookEventPayload {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

function getServerJsonPath(tmpHome: string): string {
  return path.join(tmpHome, '.pixel-agents', 'server.json');
}

function isHookServerConfig(value: unknown): value is HookServerConfig {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.port === 'number' &&
    typeof candidate.pid === 'number' &&
    typeof candidate.token === 'string' &&
    typeof candidate.startedAt === 'number'
  );
}

function readHookServerConfig(tmpHome: string): HookServerConfig | null {
  try {
    const raw = fs.readFileSync(getServerJsonPath(tmpHome), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isHookServerConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function probeHookServer(config: HookServerConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHookServer(
  tmpHome: string,
  timeoutMs = 20_000,
): Promise<HookServerConfig> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const config = readHookServerConfig(tmpHome);
    if (config && (await probeHookServer(config))) {
      return config;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for hook server config at ${getServerJsonPath(tmpHome)}`);
}

export async function sendHookEvent(
  config: HookServerConfig,
  event: HookEventPayload,
  provider = 'claude',
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${config.port}/api/hooks/${provider}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Hook event ${event.hook_event_name} failed with ${response.status}: ${body || '<empty>'}`,
    );
  }
}

export function sessionStartStartup(
  sessionId: string,
  cwd: string,
  transcriptPath?: string,
): HookEventPayload {
  const event: HookEventPayload = {
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd,
  };
  if (transcriptPath) event.transcript_path = transcriptPath;
  return event;
}

export function sessionStartClear(
  sessionId: string,
  cwd: string,
  transcriptPath?: string,
): HookEventPayload {
  const event: HookEventPayload = {
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    source: 'clear',
    cwd,
  };
  if (transcriptPath) event.transcript_path = transcriptPath;
  return event;
}

export function sessionStartResume(
  sessionId: string,
  cwd: string,
  transcriptPath?: string,
): HookEventPayload {
  const event: HookEventPayload = {
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    source: 'resume',
    cwd,
  };
  if (transcriptPath) event.transcript_path = transcriptPath;
  return event;
}

export function preToolUseBash(sessionId: string, command: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: {
      command,
    },
  };
}

export function preToolUseAgent(
  sessionId: string,
  description: string,
  runInBackground = true,
): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description,
      run_in_background: runInBackground,
    },
  };
}

export function subagentStart(sessionId: string, agentType: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'SubagentStart',
    agent_type: agentType,
  };
}

export function permissionRequest(sessionId: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'PermissionRequest',
  };
}

export function notificationPermissionPrompt(sessionId: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
  };
}

export function idlePrompt(sessionId: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
  };
}

export function teammateIdle(sessionId: string, agentType: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'TeammateIdle',
    agent_type: agentType,
  };
}

export function taskCompleted(
  sessionId: string,
  agentType: string,
  subject = 'Task completed',
): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'TaskCompleted',
    agent_type: agentType,
    subject,
  };
}

export function sessionEndExit(sessionId: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'SessionEnd',
    reason: 'exit',
  };
}

export function sessionEndClear(sessionId: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'SessionEnd',
    reason: 'clear',
  };
}

export function sessionEndResume(sessionId: string): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'SessionEnd',
    reason: 'resume',
  };
}
