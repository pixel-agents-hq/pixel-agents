/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { claudeProvider } from './hook/claude/claude.js';
import { copyHookScript } from './hook/claude/claudeHookInstaller.js';
import { copilotProvider } from './hook/copilot/copilot.js';

export { claudeProvider, copilotProvider, copyHookScript };

const PROVIDERS: Readonly<Record<string, HookProvider>> = {
  [claudeProvider.id]: claudeProvider,
  [copilotProvider.id]: copilotProvider,
};

export function getHookProvider(providerId: string | undefined): HookProvider {
  if (providerId && PROVIDERS[providerId]) {
    return PROVIDERS[providerId];
  }
  return claudeProvider;
}
