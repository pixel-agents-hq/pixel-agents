import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { HookEvent } from '../src/hookEventHandler.js';
import { kiroProvider } from '../src/providers/hook/kiro/kiro.js';

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/kiro-hook.js');
let tmpBase: string;

function runHook(event: string, raw: unknown): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, event], {
      env: {
        ...process.env,
        HOME: tmpBase,
        USERPROFILE: tmpBase,
        PIXEL_AGENTS_KIRO_SESSION_ID: 'office-session',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(JSON.stringify(raw));
  });
}

describe('bundled Kiro hook process', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kiro-hook-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
  const itBuilt = it.skipIf(!fs.existsSync(HOOK_SCRIPT));

  itBuilt('sends sanitized real hook activity over authenticated loopback HTTP', async () => {
    const received: Array<{ url: string; auth: string; body: unknown }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk;
      });
      request.on('end', () => {
        received.push({
          url: request.url ?? '',
          auth: request.headers.authorization ?? '',
          body: JSON.parse(body) as unknown,
        });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpBase, '.pixel-agents', 'server.json'),
        JSON.stringify({ port, token: 'local-test-token', pid: process.pid }),
      );
      const result = await runHook('PreToolUse', {
        session_id: 'native-id',
        tool_name: 'fs_read',
        tool_input: { path: 'main.ts' },
        prompt: 'private',
        tool_output: 'private output',
      });
      expect(result).toEqual({ code: 0, output: '' });
      expect(received).toEqual([
        {
          url: '/api/hooks/kiro',
          auth: 'Bearer local-test-token',
          body: {
            hook_event_name: 'PreToolUse',
            session_id: 'office-session',
            tool_name: 'fs_read',
            tool_input: { path: 'main.ts' },
          },
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  itBuilt(
    'drives Active, reading activity and Done through the real hook process and runtime',
    async () => {
      const store = new AgentStateStore();
      const runtime = new AgentRuntime(store, kiroProvider);
      const messages: Array<Record<string, unknown>> = [];
      store.on('broadcast', (message) => messages.push(message));
      store.set(
        1,
        createAgentState({
          id: 1,
          sessionId: 'office-session',
          projectDir: tmpBase,
          jsonlFile: '',
          isExternal: false,
          providerId: 'kiro',
        }),
      );
      runtime.registerAgent('office-session', 1);
      const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk;
        });
        request.on('end', () => {
          if (
            request.url !== '/api/hooks/kiro' ||
            request.headers.authorization !== 'Bearer runtime-test-token'
          ) {
            response.writeHead(401).end();
            return;
          }
          runtime.handleHookEvent('kiro', JSON.parse(body) as HookEvent);
          response.end('ok');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as { port: number }).port;
        fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
        fs.writeFileSync(
          path.join(tmpBase, '.pixel-agents', 'server.json'),
          JSON.stringify({ port, token: 'runtime-test-token', pid: process.pid }),
        );
        await runHook('SessionStart', { session_id: 'native-session', cwd: tmpBase });
        expect(store.get(1)?.hookDelivered).toBe(true);
        await runHook('UserPromptSubmit', {
          session_id: 'native-session',
          prompt: 'not forwarded',
        });
        expect(messages).toContainEqual({ type: 'agentStatus', id: 1, status: 'active' });
        await runHook('PreToolUse', {
          session_id: 'native-session',
          tool_name: 'read_file',
          tool_input: { path: 'main.ts' },
        });
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'agentToolStart',
            id: 1,
            status: 'Reading main.ts',
            toolName: 'read_file',
          }),
        );
        expect(kiroProvider.readingTools.has('read_file')).toBe(true);
        await runHook('PostToolUse', { session_id: 'native-session', tool_name: 'read_file' });
        expect(messages).toContainEqual(expect.objectContaining({ type: 'agentToolDone', id: 1 }));
        await runHook('Stop', { session_id: 'native-session' });
        expect(messages).toContainEqual({ type: 'agentToolsClear', id: 1 });
        expect(messages).toContainEqual({
          type: 'agentStatus',
          id: 1,
          status: 'waiting',
          awaitingInput: false,
        });
        expect(store.get(1)?.isWaiting).toBe(true);
        expect(runtime.jsonlPollTimers.size).toBe(0);
        expect(messages.some((message) => message.type === 'agentToolPermission')).toBe(false);
        expect(messages.some((message) => message.type === 'subagentToolStart')).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        runtime.dispose();
        store.dispose();
      }
    },
  );

  itBuilt('exits successfully and silently when no office exists', async () => {
    expect(await runHook('Stop', { session_id: 'native-id' })).toEqual({ code: 0, output: '' });
  });
});
