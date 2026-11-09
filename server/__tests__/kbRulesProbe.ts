import { extractGuardFields } from '../src/providers/hook/claude/guard/fieldExtraction.js';
import { planGuard } from '../src/providers/hook/claude/guard/hookGuard.js';
import { writeRoleSnapshot } from '../src/roleStorage.js';
import type { ServerConfig } from '../src/serverConfig.js';
import type { PathNormalizer } from '../src/writeGuard/pathNormalization.js';
import { pathNormalizer } from '../src/writeGuard/pathNormalization.js';
import type { GuardVerdict } from '../src/writeGuard/protocol.js';
import { WriteGuard } from '../src/writeGuard/writeGuard.js';
import type { KbHarness } from './curatorHarness.js';

/**
 * Drives the real WriteGuard the way the hook does: a PreToolUse payload goes
 * through the hook-side field extraction and path normalization (planGuard),
 * and the request body it would POST is handed to WriteGuard.verdict.
 */

const SERVER: ServerConfig = {
  port: 4100,
  pid: process.pid,
  token: 't',
  startedAt: 0,
  servesSpa: true,
  protocol: 1,
  standalone: { terminal: true, host: '127.0.0.1', allowedHosts: [] },
};

export class GuardProbe {
  readonly guard: WriteGuard;

  /** The same normalizer drives the hook side (planGuard) and the server side (WriteGuard). */
  constructor(
    private readonly h: KbHarness,
    private readonly normalizer: PathNormalizer = pathNormalizer,
  ) {
    this.guard = new WriteGuard({
      store: h.store,
      ptyManager: h.manager,
      sessions: h.runtime,
      curators: h.curators,
      normalizer,
    });
  }

  /** Launch a PTY agent (no capability), optionally with a Role; returns its id. */
  async launch(directoryPath: string, roleId?: string): Promise<number> {
    const role =
      roleId === undefined
        ? undefined
        : {
            name: roleId.replace(/\.md$/, ''),
            roleId,
            snapshotPath: await writeRoleSnapshot(Buffer.from('# role\n')),
          };
    const { id } = this.h.launch({ directoryPath, role });
    if (id === null) throw new Error('launch failed');
    return id;
  }

  /** The verdict for one file-tool call; `rawPath` undefined omits the path field. */
  ask(agentId: number, tool: string, rawPath: string | undefined, cwd?: string): GuardVerdict {
    const agent = this.h.store.get(agentId);
    if (!agent) throw new Error(`no agent ${agentId}`);
    const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: agent.sessionId,
      cwd: cwd ?? agent.directoryRealPath ?? '',
      tool_name: tool,
      tool_input: rawPath === undefined ? { content: 'x' } : { [field]: rawPath, content: 'x' },
    };
    const plan = planGuard(payload, [SERVER], {
      extractFields: extractGuardFields,
      normalizer: this.normalizer,
      readList: () => ({
        version: 1,
        pid: SERVER.pid,
        port: SERVER.port,
        protectedRoots: this.guard.getProtectedRoots(),
        knownSessions: [agent.sessionId],
      }),
    });
    if (!plan) throw new Error('no plan');
    const verdict = this.guard.verdict(JSON.parse(plan.body) as unknown);
    if (!verdict) throw new Error('malformed request');
    return verdict;
  }

  dispose(): void {
    this.guard.dispose();
  }
}
