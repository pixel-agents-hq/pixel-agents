/**
 * Provider registry: a lookup table over all bundled `HookProvider`s, resolved
 * by `providerId` (the `POST /api/hooks/:providerId` route param).
 *
 * Before this registry existed, `providerId` was accepted and validated but
 * never actually consumed for dispatch -- every hook route reached the same
 * hardcoded Claude provider instance regardless of the id in the URL. This
 * file is the fix: `getProvider(id)` resolves the real provider for that id,
 * falling back to the default (Claude) for any unregistered id so existing
 * callers that don't know about new providers keep working exactly as before.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below and register it in `ALL_PROVIDERS`.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { claudeProvider } from './hook/claude/claude.js';
import { webProvider } from './hook/web/web.js';

export { claudeProvider } from './hook/claude/claude.js';
export { copyHookScript } from './hook/claude/claudeHookInstaller.js';
export { webProvider } from './hook/web/web.js';

/** Provider id used when an unregistered `providerId` is requested. Preserves
 *  the pre-registry behavior of "every hook POST reaches the Claude provider"
 *  for any id the registry doesn't recognize. */
export const DEFAULT_PROVIDER_ID = claudeProvider.id;

const ALL_PROVIDERS: readonly HookProvider[] = [claudeProvider, webProvider];

const providersById = new Map<string, HookProvider>(ALL_PROVIDERS.map((p) => [p.id, p]));

/** Resolve a `HookProvider` by id, falling back to `DEFAULT_PROVIDER_ID` for
 *  any id not registered above. */
export function getProvider(id: string): HookProvider | undefined {
  return providersById.get(id) ?? providersById.get(DEFAULT_PROVIDER_ID);
}

/** All registered providers, e.g. for unioning capabilities across every
 *  provider (see `clientMessageHandler.ts`'s `providerCapabilities` message). */
export function getAllProviders(): readonly HookProvider[] {
  return ALL_PROVIDERS;
}

/** Small resolver interface `HookEventHandler` depends on, so tests can supply
 *  a fake registry without importing every real provider. */
export interface ProviderRegistry {
  getProvider(id: string): HookProvider | undefined;
}

export const providerRegistry: ProviderRegistry = { getProvider };
