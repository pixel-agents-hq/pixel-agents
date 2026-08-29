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
import { copyHookScript as copyClaudeHookScript } from './hook/claude/claudeHookInstaller.js';
import { cursorProvider } from './hook/cursor/cursor.js';
import { copyHookScript as copyCursorHookScript } from './hook/cursor/cursorHookInstaller.js';

export { claudeProvider, cursorProvider };
export { copyCursorHookScript, copyClaudeHookScript as copyHookScript };

/** Every bundled hook provider, in registration order. The consent gate loops
 *  over this at the webviewReady handshake (one ask per provider that needs
 *  one) and `hooksConsentResponse` resolves its provider id against it. */
export const hookProviders: readonly HookProvider[] = [claudeProvider, cursorProvider];

/** Resolve a wire-supplied provider id, or undefined for an unknown one —
 *  the caller writes nothing on undefined (fail-closed, like a junk choice). */
export function hookProviderById(id: unknown): HookProvider | undefined {
  return typeof id === 'string' ? hookProviders.find((p) => p.id === id) : undefined;
}

/** Copy the bundled hook script for one provider. Unknown ids are a no-op
 *  success so a future provider without a script is not blocked. */
export function copyProviderHookScript(extensionPath: string, providerId: string): boolean {
  if (providerId === claudeProvider.id) return copyClaudeHookScript(extensionPath);
  if (providerId === cursorProvider.id) return copyCursorHookScript(extensionPath);
  return true;
}

/** Union of reading / subagent tool names across bundled hook providers so
 *  the webview can animate Cursor tools without dropping Claude's. */
export function mergedProviderCapabilities(): {
  readingTools: string[];
  subagentToolNames: string[];
} {
  const readingTools = new Set<string>();
  const subagentToolNames = new Set<string>();
  for (const provider of hookProviders) {
    for (const tool of provider.readingTools) readingTools.add(tool);
    for (const tool of provider.subagentToolNames) subagentToolNames.add(tool);
  }
  return { readingTools: [...readingTools], subagentToolNames: [...subagentToolNames] };
}
