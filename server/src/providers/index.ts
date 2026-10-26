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
import { openClawProvider } from './hook/openclaw/openclaw.js';

export { claudeProvider, openClawProvider };
export { copyHookScript } from './hook/claude/claudeHookInstaller.js';
export { copyOpenClawPlugin } from './hook/openclaw/openclawPluginInstaller.js';

/** Every bundled hook provider, in registration order. The consent gate loops
 *  over this at the webviewReady handshake (one ask per provider that needs
 *  one) and `hooksConsentResponse` resolves its provider id against it. */
export const hookProviders: readonly HookProvider[] = [claudeProvider, openClawProvider];

/** Existing office protocol carries one taxonomy for all observed providers. */
export function hookProviderCapabilities(): {
  readingTools: string[];
  subagentToolNames: string[];
} {
  return {
    readingTools: [...new Set(hookProviders.flatMap((provider) => [...provider.readingTools]))],
    subagentToolNames: [
      ...new Set(hookProviders.flatMap((provider) => [...provider.subagentToolNames])),
    ],
  };
}

/** Resolve a wire-supplied provider id, or undefined for an unknown one —
 *  the caller writes nothing on undefined (fail-closed, like a junk choice). */
export function hookProviderById(id: unknown): HookProvider | undefined {
  return typeof id === 'string' ? hookProviders.find((p) => p.id === id) : undefined;
}
