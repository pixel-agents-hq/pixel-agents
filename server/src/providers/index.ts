/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add it to HOOK_PROVIDERS and copyProviderHookScript below.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { claudeProvider } from './hook/claude/claude.js';
import { copyHookScript as copyClaudeHookScript } from './hook/claude/claudeHookInstaller.js';
import { codexProvider } from './hook/codex/codex.js';
import { copyHookScript as copyCodexHookScript } from './hook/codex/codexHookInstaller.js';

export type AgentEngineId = 'claude-code' | 'claude' | 'codex';

const HOOK_PROVIDERS = [claudeProvider, codexProvider] as const;

export function resolveProvider(engine?: string): HookProvider {
  switch (engine) {
    case 'codex':
      return codexProvider;
    case 'claude':
    case 'claude-code':
    case undefined:
    case '':
      return claudeProvider;
    default:
      console.warn(`[Pixel Agents] Unknown agent engine "${engine}", falling back to Claude Code`);
      return claudeProvider;
  }
}

export function copyProviderHookScript(providerId: string, extensionPath: string): void {
  switch (providerId) {
    case claudeProvider.id:
      copyClaudeHookScript(extensionPath);
      break;
    case codexProvider.id:
      copyCodexHookScript(extensionPath);
      break;
    default:
      console.warn(`[Pixel Agents] No hook script copier registered for provider "${providerId}"`);
      break;
  }
}

export function getHookProviders(): readonly HookProvider[] {
  return HOOK_PROVIDERS;
}

export { claudeProvider, codexProvider };
export { copyClaudeHookScript, copyCodexHookScript };
export { copyClaudeHookScript as copyHookScript };
