import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PermissionPending } from '../../core/src/messages.js';
import { createAgentState } from '../src/agentState.js';
import { MCP_PATH, MCP_PROTOCOL_VERSIONS } from '../src/constants.js';
import type { McpTool } from '../src/mcp/mcpProtocol.js';
import { handleMcpMessage, McpToolError } from '../src/mcp/mcpProtocol.js';
import { mcpRequestRefusal, registerMcpRoute } from '../src/mcp/mcpRoute.js';
import type { OfficeView } from '../src/mcp/officeTools.js';
import { officeTools, transcriptItems, UNTRUSTED_NOTE } from '../src/mcp/officeTools.js';
import type { AgentState } from '../src/types.js';

/**
 * The office as a read-only MCP server (server/src/mcp/): the JSON-RPC
 * handler, the route's gates (token, Host, Origin), and the five tools over a
 * fake OfficeView -- no runtime, no real ~/.claude.
 */

const MIN = 60_000;
const T0 = new Date(2026, 9, 18, 14, 0, 0).getTime();
const TOKEN = 'test-token';
const HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', 'box.tail.ts.net']);
const INFO = { name: 'pixel-agents', version: '1.5.0' };

function agent(id: number, extra: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id,
    sessionId: `s${id}`,
    isExternal: true,
    projectDir: '/p',
    jsonlFile: '',
    directoryName: 'hobbyfi-blog',
    ...extra,
  });
}

function view(over: Partial<OfficeView> = {}): OfficeView {
  return {
    agents: () => [],
    pendingApprovals: () => [],
    sources: {},
    tasksFor: () => [],
    usage: () => undefined,
    formatToolStatus: (name) => `Using ${name}`,
    now: () => T0,
    ...over,
  };
}

/** Call a tool through the protocol and return its parsed result (or error text). */
function call(tools: McpTool[], name: string, args: Record<string, unknown> = {}) {
  const out = handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    tools,
    INFO,
  );
  if (out.status !== 200 || !('result' in out.body)) throw new Error('expected a result');
  const result = out.body.result as { content: Array<{ text: string }>; isError?: boolean };
  return result.isError
    ? { error: result.content[0].text }
    : (JSON.parse(result.content[0].text) as Record<string, unknown>);
}

describe('the protocol', () => {
  const tools = officeTools(view());

  it('initialize: echoes a revision it speaks, else offers its newest', () => {
    for (const [asked, got] of [
      ['2025-06-18', '2025-06-18'],
      ['1999-01-01', MCP_PROTOCOL_VERSIONS[0]],
    ]) {
      const out = handleMcpMessage(
        { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: asked } },
        tools,
        INFO,
      );
      expect(out).toMatchObject({
        status: 200,
        body: {
          id: 'a',
          result: {
            protocolVersion: got,
            capabilities: { tools: {} },
            serverInfo: { name: 'pixel-agents', version: '1.5.0' },
          },
        },
      });
    }
  });

  it('tools/list: five tools, every one marked read-only', () => {
    const out = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools, INFO);
    const listed = (out as { body: { result: { tools: Array<Record<string, unknown>> } } }).body
      .result.tools;
    expect(listed.map((t) => t.name)).toEqual([
      'list_agents',
      'read_agent',
      'pending_approvals',
      'tasks_today',
      'usage',
    ]);
    for (const t of listed) {
      expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('notifications and stray responses get 202; bad messages and methods get errors', () => {
    expect(
      handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, INFO),
    ).toEqual({ status: 202 });
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 5, result: {} }, tools, INFO)).toMatchObject({
      status: 200,
      body: { error: { code: -32600 } },
    });
    expect(handleMcpMessage([{ jsonrpc: '2.0', id: 1 }], tools, INFO)).toMatchObject({
      body: { error: { code: -32600 } },
    });
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'nope' }, tools, INFO)).toMatchObject({
      body: { id: 3, error: { code: -32601 } },
    });
    expect(
      handleMcpMessage(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'launch_agent' } },
        tools,
        INFO,
      ),
    ).toMatchObject({ body: { error: { code: -32602 } } });
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'ping' }, tools, INFO)).toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 6, result: {} },
    });
  });

  it('a tool’s McpToolError is an isError result the model can read; other throws are internal', () => {
    const boom: McpTool[] = [
      {
        name: 'a',
        title: 'a',
        description: '',
        inputSchema: {},
        run: () => {
          throw new McpToolError('bad id');
        },
      },
      {
        name: 'b',
        title: 'b',
        description: '',
        inputSchema: {},
        run: () => {
          throw new Error('secret stack');
        },
      },
    ];
    expect(call(boom, 'a')).toEqual({ error: 'bad id' });
    const out = handleMcpMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'b' } },
      boom,
      INFO,
    );
    expect(out).toMatchObject({ body: { error: { code: -32603, message: 'Internal error' } } });
  });
});

describe('the gates', () => {
  const ok = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:3100' };

  it('needs the token first, then an allowed Host, then an allowed Origin if one is sent', () => {
    expect(mcpRequestRefusal(ok, TOKEN, HOSTS)).toBeNull();
    expect(mcpRequestRefusal({ ...ok, host: 'box.tail.ts.net' }, TOKEN, HOSTS)).toBeNull();
    expect(mcpRequestRefusal({ ...ok, authorization: undefined }, TOKEN, HOSTS)?.status).toBe(401);
    expect(mcpRequestRefusal({ ...ok, authorization: 'Bearer x' }, TOKEN, HOSTS)?.status).toBe(401);
    // A token-less probe learns nothing about the Host allowlist.
    expect(mcpRequestRefusal({ host: 'evil.com' }, TOKEN, HOSTS)?.status).toBe(401);
    expect(mcpRequestRefusal({ ...ok, host: 'evil.com:3100' }, TOKEN, HOSTS)?.status).toBe(403);
    expect(mcpRequestRefusal({ ...ok, origin: 'http://evil.com:3100' }, TOKEN, HOSTS)?.status).toBe(
      403,
    );
    expect(mcpRequestRefusal({ ...ok, origin: 'not a url' }, TOKEN, HOSTS)?.status).toBe(403);
    expect(mcpRequestRefusal({ ...ok, origin: 'http://localhost:3100' }, TOKEN, HOSTS)).toBeNull();
    // An empty configured token never authorizes.
    expect(mcpRequestRefusal({ ...ok, authorization: 'Bearer ' }, '', HOSTS)?.status).toBe(401);
  });

  it('over HTTP: POST answers JSON-RPC, notifications 202, GET/DELETE 405, bad version 400', async () => {
    const app = Fastify();
    registerMcpRoute(app, { token: TOKEN, allowedHostnames: HOSTS, office: view(), version: '' });
    const post = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: MCP_PATH,
        headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:3100', ...headers },
        payload: payload as Record<string, unknown>,
      });
    try {
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      expect(init.statusCode).toBe(200);
      expect(init.headers['content-type']).toMatch(/application\/json/);
      expect(init.json()).toMatchObject({ result: { serverInfo: { version: '0.0.0' } } });

      const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(note.statusCode).toBe(202);
      expect(note.body).toBe('');

      expect(
        (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: '' })).statusCode,
      ).toBe(401);
      expect(
        (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1.0' }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await post(
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { 'mcp-protocol-version': '2025-06-18' },
          )
        ).statusCode,
      ).toBe(200);

      for (const method of ['GET', 'DELETE'] as const) {
        const res = await app.inject({
          method,
          url: MCP_PATH,
          headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1' },
        });
        expect(res.statusCode).toBe(405);
        expect(res.headers.allow).toBe('POST');
        const anon = await app.inject({ method, url: MCP_PATH, headers: { host: '127.0.0.1' } });
        expect(anon.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});

describe('the tools', () => {
  it('list_agents: ids, statuses and waits, with today’s totals', () => {
    const working = agent(7, { title: 'Ship the strip' });
    working.activeToolNames.set('t1', 'Edit');
    working.activeToolStatuses.set('t1', 'Editing App.tsx');
    const approval: PermissionPending = {
      type: 'permissionPending',
      requestId: 'r',
      id: 9,
      tool: 'Bash',
      detail: 'rm -rf build',
      since: T0 - 3 * MIN,
    };
    const tools = officeTools(
      view({
        agents: () => [
          [7, working],
          [9, agent(9, { directoryName: 'api' })],
        ],
        pendingApprovals: () => [approval],
        sources: { todayTasks: () => ({ done: 2, open: 1, waiting: 0 }) },
      }),
    );
    expect(call(tools, 'list_agents')).toMatchObject({
      time: '14:00',
      agents: [
        {
          id: 7,
          repo: 'hobbyfi-blog',
          task: 'Ship the strip',
          status: 'working',
          doing: 'Editing App.tsx',
        },
        { id: 9, repo: 'api', status: 'needs approval', waitingMin: 3, approvalFor: 'Bash' },
      ],
      today: { tasksDone: 2, tasksOpen: 1 },
    });
  });

  it('pending_approvals: who, what and how long, labelled as agent output', () => {
    const tools = officeTools(
      view({
        agents: () => [[9, agent(9, { directoryName: 'api' })]],
        pendingApprovals: () => [
          {
            type: 'permissionPending',
            requestId: 'r',
            id: 9,
            tool: 'Bash',
            detail: 'rm -rf build',
            since: T0 - 12 * MIN,
          },
        ],
      }),
    );
    expect(call(tools, 'pending_approvals')).toEqual({
      note: UNTRUSTED_NOTE,
      approvals: [
        { agentId: 9, repo: 'api', tool: 'Bash', detail: 'rm -rf build', waitingMin: 12 },
      ],
    });
  });

  it('usage: the two windows when known, a hint when not', () => {
    expect(call(officeTools(view()), 'usage')).toMatchObject({ known: false });
    const resetsAt = T0 + 90 * MIN;
    const tools = officeTools(
      view({
        usage: () => ({
          type: 'subscriptionUsage',
          fiveHour: { usedPercentage: 23, resetsAt },
          updatedAt: T0,
        }),
      }),
    );
    expect(call(tools, 'usage')).toEqual({
      known: true,
      fiveHour: { usedPercent: 23, resetsAt: new Date(resetsAt).toISOString() },
      updatedAt: new Date(T0).toISOString(),
    });
  });

  it('tasks_today: the report data for the local date', () => {
    let asked = '';
    const tools = officeTools(
      view({
        tasksFor: (date) => {
          asked = date;
          return [];
        },
      }),
    );
    expect(call(tools, 'tasks_today')).toMatchObject({
      date: '2026-10-18',
      totals: { done: 0, open: 0, waiting: 0 },
    });
    expect(asked).toBe('2026-10-18');
  });

  describe('read_agent', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mcp-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const line = (record: Record<string, unknown>) => JSON.stringify(record);
    const TRANSCRIPT = [
      line({ type: 'user', isMeta: true, message: { content: 'injected caveat' } }),
      line({ type: 'user', timestamp: 't1', message: { content: 'Fix the login test' } }),
      line({
        type: 'assistant',
        timestamp: 't2',
        message: {
          content: [
            { type: 'thinking', thinking: 'secret thoughts' },
            { type: 'text', text: 'Looking at it.' },
            { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      }),
      line({
        type: 'user',
        timestamp: 't3',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'exit 1' },
            { type: 'tool_result', tool_use_id: 'u0', content: 'ok output' },
          ],
        },
      }),
      line({ type: 'assistant', isSidechain: true, message: { content: 'a sub-agent talking' } }),
      'not json',
      line({ type: 'system', subtype: 'turn_duration' }),
      '',
    ];

    it('keeps prompts, replies, tools run and failures; drops thinking, meta, sidechain, success output', () => {
      expect(transcriptItems(TRANSCRIPT, (n) => `Running ${n}`)).toEqual([
        { at: 't1', who: 'user', text: 'Fix the login test' },
        { at: 't2', who: 'agent', text: 'Looking at it.' },
        { at: 't2', who: 'tool', text: 'Running Bash' },
        { at: 't3', who: 'tool failed', text: 'exit 1' },
      ]);
      // A teammate's own transcript is sidechain top to bottom: it is used then.
      expect(
        transcriptItems(
          [line({ type: 'assistant', isSidechain: true, message: { content: 'hi' } })],
          (n) => n,
        ),
      ).toEqual([{ who: 'agent', text: 'hi' }]);
    });

    it('reads the newest items of an agent’s transcript, and refuses unknown ids', () => {
      const file = path.join(dir, 's.jsonl');
      fs.writeFileSync(file, TRANSCRIPT.join('\n'));
      const tools = officeTools(
        view({ agents: () => [[3, agent(3, { jsonlFile: file, title: 'Login' })]] }),
      );
      expect(call(tools, 'read_agent', { agentId: 3, items: 2 })).toEqual({
        agentId: 3,
        repo: 'hobbyfi-blog',
        task: 'Login',
        note: UNTRUSTED_NOTE,
        items: [
          { at: 't2', who: 'tool', text: 'Using Bash' },
          { at: 't3', who: 'tool failed', text: 'exit 1' },
        ],
      });
      expect(call(tools, 'read_agent', { agentId: 4 })).toEqual({
        error: 'No agent 4 in the office. Call list_agents for the ids.',
      });
      expect(call(tools, 'read_agent', { agentId: '3' })).toMatchObject({
        error: expect.any(String),
      });
    });

    it('says why when there is no transcript to read', () => {
      const tools = officeTools(
        view({
          agents: () => [
            [1, agent(1)],
            [2, agent(2, { jsonlFile: path.join(dir, 'missing.jsonl') })],
          ],
        }),
      );
      expect(call(tools, 'read_agent', { agentId: 1 })).toMatchObject({
        items: [],
        why: expect.any(String),
      });
      expect(call(tools, 'read_agent', { agentId: 2 })).toMatchObject({
        items: [],
        why: expect.any(String),
      });
    });
  });
});
