/**
 * Composite HookProvider that dispatches to multiple providers.
 *
 * Used in the standalone CLI to support both Claude Code (default) and
 * OpenCode (via webhook bridge) simultaneously without modifying the
 * core AgentRuntime or HookEventHandler.
 *
 * The composite delegates by trying each provider's normalizeHookEvent
 * in registration order; the first non-null result wins.
 * Methods that are provider-specific (getSessionDirs, buildLaunchCommand,
 * formatToolStatus, etc.) check the agent's session and route to the
 * matching provider.
 */

import type { AgentEvent, HookProvider } from '../../core/src/provider.js';

export function createCompositeProvider(...providers: HookProvider[]): HookProvider {
  if (providers.length === 0) throw new Error('At least one provider required');
  const primary = providers[0];

  return {
    kind: 'hook',
    id: 'composite',
    displayName: providers.map((p) => p.displayName).join(' + '),
    protocolVersion: primary.protocolVersion,

    normalizeHookEvent(raw: Record<string, unknown>): { sessionId: string; event: AgentEvent } | null {
      for (const p of providers) {
        const result = p.normalizeHookEvent(raw);
        if (result) return result;
      }
      return null;
    },

    installHooks: () => primary.installHooks(),
    uninstallHooks: () => primary.uninstallHooks(),
    areHooksInstalled: () => primary.areHooksInstalled(),

    formatToolStatus: (toolName: string, input?: unknown) => primary.formatToolStatus(toolName, input),
    permissionExemptTools: primary.permissionExemptTools,
    subagentToolNames: primary.subagentToolNames,
    readingTools: primary.readingTools,
    terminalNamePrefix: primary.terminalNamePrefix,

    getSessionDirs: (workspacePath: string) => primary.getSessionDirs?.(workspacePath),
    getAllSessionRoots: () => primary.getAllSessionRoots?.(),
    sessionFilePattern: primary.sessionFilePattern,
    parseTranscriptLine: (line: string) => primary.parseTranscriptLine?.(line) ?? null,
    buildLaunchCommand: (sessionId: string, cwd: string, opts?: { bypassPermissions?: boolean }) =>
      primary.buildLaunchCommand?.(sessionId, cwd, opts) ?? {
        command: '',
        args: [],
        env: { PWD: cwd },
      },

    team: primary.team,
  };
}
