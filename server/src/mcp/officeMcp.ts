/**
 * The Pixel Office MCP (server id `pixel-office`): ONE module owning its route
 * (`/mcp`, Streamable HTTP, stateless), its tool table (./tools/) and the
 * per-agent token registry.
 *
 * Access is injected at launch, never installed: with consent granted, every
 * launch and resume through this office's launch path gets `--mcp-config
 * <file>`, a 0600 file under ~/.pixel-agents/mcp/<this server>/ holding the
 * endpoint and a token minted for that agent alone (`configFor`). The token is
 * the caller's identity — there is no other — and it lives only in memory: it
 * dies with the agent (its removal from the store), with this server, and all
 * at once when the feature is turned off. Never the server's own token.
 *
 * Stateless: every request is authenticated afresh and served by a fresh MCP
 * server bound to its caller, so a revoked token is refused on its very next
 * call and the read-only setting is read per call.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import type { OfficeMcpConsentRequest, OfficeMcpStatus } from '../../../core/src/messages.js';
import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import {
  getOfficeMcpConsent,
  getOfficeMcpReadOnly,
  type OfficeMcpConsentAnswer,
  setOfficeMcpConsent,
  setOfficeMcpReadOnly,
} from '../configPersistence.js';
import {
  OFFICE_MCP_CONFIG_DIR,
  OFFICE_MCP_MAX_BODY_SIZE,
  OFFICE_MCP_PATH,
  OFFICE_MCP_READ_ONLY_REASON,
  OFFICE_MCP_SERVER_NAME,
  OFFICE_MCP_TOKEN_BYTES,
  PIXEL_AGENTS_DIR,
} from '../constants.js';
import { tutorialMcpInstructions } from '../tutorial/tutorialCopy.js';
import { OFFICE_MCP_DISCLOSURE, OFFICE_MCP_HEADLINE, OFFICE_MCP_SUMMARY } from './consentCopy.js';
import type { OfficeCapabilities, OfficeOperations } from './officeOperations.js';
import type { OfficeTool, ToolContext } from './tool.js';
import { OFFICE_TOOLS } from './tools/index.js';

/** What a launch path needs from the MCP: an agent's config file, and taking
 *  it back when the launch never happened. */
export interface AgentMcpAccess {
  /** Mint `agentId`'s token and write its `--mcp-config` file; the file's path,
   *  or undefined when agents get no MCP (not consented, or not serving). */
  configFor(agentId: number): string | undefined;
  /** Revoke `agentId`'s token and delete its file (no-op when it has none). */
  revoke(agentId: number): void;
}

export interface OfficeMcpOptions {
  office: OfficeOperations;
  /** The CLI the office launches: it writes an agent's config file in its own
   *  format (`mcpConfigFile`; one that has none is offered no MCP) and says
   *  how the tutorial's skill is invoked (`skills`). */
  provider: Pick<HookProvider, 'mcpConfigFile' | 'skills'>;
  /** Defaults to every tool in ./tools/. Only those whose `uses` the office
   *  supplies are offered. */
  tools?: readonly OfficeTool[];
}

/** The tools a surface's office can serve: each one's capabilities all supplied. */
export function toolsFor(office: OfficeOperations, tools: readonly OfficeTool[]): OfficeTool[] {
  const supplied = office as Partial<OfficeCapabilities>;
  return tools.filter((tool) =>
    tool.uses.every((capability) => supplied[capability] !== undefined),
  );
}

interface Grant {
  token: string;
  file: string;
}

export class OfficeMcp implements AgentMcpAccess {
  private readonly office: OfficeOperations;
  private readonly provider: Pick<HookProvider, 'mcpConfigFile' | 'skills'>;
  private readonly tools: readonly OfficeTool[];
  private readonly agentOfToken = new Map<string, number>();
  private readonly grants = new Map<number, Grant>();
  /** This server's own folder of config files: `<pid>-<random>`, so another
   *  live server's agents are never touched and a crashed one's are pruned. */
  private readonly configDir: string;
  private endpoint: string | null = null;
  private detachStore: (() => void) | null = null;

  constructor(options: OfficeMcpOptions) {
    this.office = options.office;
    this.provider = options.provider;
    this.tools = toolsFor(options.office, options.tools ?? OFFICE_TOOLS);
    const root = path.join(os.homedir(), PIXEL_AGENTS_DIR, OFFICE_MCP_CONFIG_DIR);
    pruneDeadServerDirs(root);
    this.configDir = path.join(root, `${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  }

  // ── Wiring ────────────────────────────────────────────────

  /** Tokens die with their agents: follow the store's removals. */
  attach(store: AgentStateStore): void {
    this.detachStore?.();
    const onRemoved = (id: number): void => this.revoke(id);
    store.on('agentRemoved', onRemoved);
    this.detachStore = () => store.off('agentRemoved', onRemoved);
  }

  /** The URL agents reach this server's /mcp at, once it listens. Until then
   *  no agent is given the MCP. */
  setEndpoint(url: string): void {
    this.endpoint = url;
  }

  /** Whether agents this office launches can be handed the MCP: this server
   *  serves /mcp (an endpoint is set) and the CLI takes a config file for it. */
  offered(): boolean {
    return this.endpoint !== null && this.provider.mcpConfigFile !== undefined;
  }

  /** Mount `/mcp` on the office server (beside the hook and usage routes). */
  registerRoutes(app: FastifyInstance): void {
    app.route({
      method: 'POST',
      url: OFFICE_MCP_PATH,
      bodyLimit: OFFICE_MCP_MAX_BODY_SIZE,
      handler: (request, reply) => this.handlePost(request, reply),
    });
    // Stateless: no server-initiated stream to open, no session to end.
    app.route({
      method: ['GET', 'DELETE'],
      url: OFFICE_MCP_PATH,
      handler: async (_request, reply) => {
        reply.code(405).header('Allow', 'POST').send(rpcError('Method not allowed.'));
      },
    });
  }

  /** Revoke everything and remove this server's config folder (shutdown). */
  dispose(): void {
    this.revokeAll();
    this.detachStore?.();
    this.detachStore = null;
    fs.rmSync(this.configDir, { recursive: true, force: true });
  }

  // ── Tokens ────────────────────────────────────────────────

  configFor(agentId: number): string | undefined {
    if (!this.endpoint || getOfficeMcpConsent() !== 'granted') return undefined;
    if (!this.provider.mcpConfigFile) return undefined;
    this.revoke(agentId);
    const token = crypto.randomBytes(OFFICE_MCP_TOKEN_BYTES).toString('base64url');
    const file = path.join(this.configDir, `agent-${agentId}.json`);
    const config = this.provider.mcpConfigFile({
      name: OFFICE_MCP_SERVER_NAME,
      url: this.endpoint,
      token,
    });
    try {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
      // A fresh path every time (revoked above), created 0600 and never wider.
      fs.writeFileSync(file, config, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(file, 0o600);
    } catch (err) {
      console.error(
        `[Pixel Agents] Pixel Office MCP: could not write agent ${agentId}'s config:`,
        err,
      );
      return undefined;
    }
    this.agentOfToken.set(token, agentId);
    this.grants.set(agentId, { token, file });
    return file;
  }

  revoke(agentId: number): void {
    const grant = this.grants.get(agentId);
    if (!grant) return;
    this.grants.delete(agentId);
    this.agentOfToken.delete(grant.token);
    fs.rmSync(grant.file, { force: true });
  }

  /** Every agent's access, at once (the feature turned off, shutdown). */
  revokeAll(): void {
    for (const agentId of [...this.grants.keys()]) this.revoke(agentId);
  }

  // ── Consent + settings (docs/adr/0001: each answer is an absolute state) ──

  /** The settings as recorded, for privileged offices. */
  statusMessage(): OfficeMcpStatus {
    return {
      type: 'officeMcpStatus',
      consent: getOfficeMcpConsent(),
      readOnly: getOfficeMcpReadOnly(),
      headline: OFFICE_MCP_HEADLINE,
      disclosure: OFFICE_MCP_DISCLOSURE,
    };
  }

  /** The Intro's ask, or null once answered. Privileged offices only: the
   *  caller asks no other (a read-only office's answer would be refused). */
  consentRequest(): OfficeMcpConsentRequest | null {
    if (getOfficeMcpConsent() !== 'unanswered') return null;
    return this.replayedConsentRequest();
  }

  /** The same ask whatever was answered: Settings → Replay the Intro. */
  replayedConsentRequest(): OfficeMcpConsentRequest {
    return {
      type: 'officeMcpConsentRequest',
      headline: OFFICE_MCP_HEADLINE,
      summary: OFFICE_MCP_SUMMARY,
      disclosure: OFFICE_MCP_DISCLOSURE,
    };
  }

  /** Record an answer (Intro or Settings). A decline revokes every running
   *  agent's access at once; a grant reaches agents launched from now on. */
  answer(answer: OfficeMcpConsentAnswer | 'unanswered'): OfficeMcpStatus {
    setOfficeMcpConsent(answer);
    if (answer !== 'granted') this.revokeAll();
    return this.statusMessage();
  }

  /** Read-only on or off; read per call, so it applies to running agents at once. */
  setReadOnly(readOnly: boolean): OfficeMcpStatus {
    setOfficeMcpReadOnly(readOnly);
    return this.statusMessage();
  }

  // ── Requests ──────────────────────────────────────────────

  /** The calling agent, or why the request is refused. */
  private callerOf(request: FastifyRequest): { caller: number } | { refused: string } {
    // Agents' clients send no Origin; a browser always does. A page that
    // somehow held a token must still not drive the office from a browser.
    if (request.headers.origin !== undefined) return { refused: 'Browser requests are refused.' };
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const caller = this.agentOfToken.get(token);
    if (caller === undefined) {
      return {
        refused:
          'Unknown or revoked Pixel Office MCP token: the agent it was minted for has left, the server restarted, or the feature was turned off.',
      };
    }
    // Turned off from another process (or by hand): honour it here too.
    if (getOfficeMcpConsent() !== 'granted') {
      this.revokeAll();
      return { refused: 'The Pixel Office MCP is turned off in Pixel Agents settings.' };
    }
    if (!this.office.agents.hasAgent(caller)) {
      this.revoke(caller);
      return { refused: 'The agent this token was minted for has left the office.' };
    }
    return { caller };
  }

  private async handlePost(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const who = this.callerOf(request);
    if ('refused' in who) {
      const code = request.headers.origin !== undefined ? 403 : 401;
      reply.code(code).send(rpcError(who.refused));
      return;
    }
    reply.hijack();
    const server = this.serverFor(who.caller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      console.error('[Pixel Agents] Pixel Office MCP request failed:', err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError('Internal error.', -32603)));
      }
    }
  }

  /** An MCP server for one request, its tools bound to `caller`. */
  private serverFor(caller: number): McpServer {
    const server = new McpServer(
      { name: OFFICE_MCP_SERVER_NAME, version: process.env.PIXEL_AGENTS_VERSION ?? '0.0.0' },
      // The tutorial's first message is only its skill's command: this is the fallback.
      { instructions: tutorialMcpInstructions(this.provider.skills) },
    );
    // Every tool registered here uses only capabilities this office supplies (toolsFor).
    const ctx: ToolContext = {
      caller,
      office: this.office as OfficeCapabilities,
      target: (agentId) => agentId ?? caller,
    };
    for (const tool of this.tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: z.object(tool.input),
          annotations: { readOnlyHint: !tool.changes },
        },
        (args: unknown) => callTool(tool, args, ctx),
      );
    }
    return server;
  }
}

/** Run one tool for its caller: read-only gate, then the tool, every outcome
 *  (a refusal, a throw) turned into a reply the agent can act on. */
async function callTool(
  tool: OfficeTool,
  args: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  if (tool.changes && getOfficeMcpReadOnly()) return errorResult(OFFICE_MCP_READ_ONLY_REASON);
  try {
    const result = await tool.run(args as never, ctx);
    if (!result.ok) return errorResult(result.reason);
    return {
      content: [
        { type: 'text', text: JSON.stringify(result.value, null, 2) },
        ...(result.images ?? []).map((image) => ({
          type: 'image' as const,
          data: image.data.toString('base64'),
          mimeType: image.mimeType,
        })),
      ],
    };
  } catch (err) {
    console.error(`[Pixel Agents] Pixel Office MCP: ${tool.name} failed:`, err);
    return errorResult(
      `${tool.name} failed inside Pixel Agents: ${err instanceof Error ? err.message : String(err)}. Try again; if it keeps failing, tell the user.`,
    );
  }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function rpcError(message: string, code = -32001): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** Remove config folders left by servers that are no longer running (a crash
 *  leaves its agents' files behind; their tokens died with it). */
function pruneDeadServerDirs(root: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^(\d+)-/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid === process.pid || isProcessRunning(pid)) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
