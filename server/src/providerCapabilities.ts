/**
 * The providerCapabilities handshake message, built once for every surface.
 *
 * Both hosts send this identically on the client's webviewReady: the standalone
 * WS handshake (clientMessageHandler) and the VS Code adapter's panel
 * handshake. Before this lived only in the WS path, the adapter shipped a
 * Claude-only snapshot (no `providers`, Claude's tool taxonomy), which made the
 * embedded webview fall back to the legacy single-Claude row: Hermes could
 * never appear in the launch drawer or Settings, and Hermes tools were
 * classified with the wrong animation/subagent rules.
 */

import type { ProviderCapabilities } from '../../core/src/messages.js';
import { hookProviders } from './providers/index.js';

/**
 * Provider capabilities — the union across the providers that report
 * themselves AVAILABLE on this machine. The union is lossless: each provider's
 * tool-name space belongs to a different CLI (Claude's PascalCase
 * `Read`/`Grep` vs Hermes' snake_case `read_file`/`search_files`), so merging
 * the sets cannot mis-classify a tool from either provider. `providers` is the
 * list Settings renders as one hooks row per integration, and the launch
 * drawer's picker source; an unavailable provider is absent from all three
 * fields, so the UI cannot offer a hook it has no way to see. Synchronous:
 * availability probes are declared SYNC on HookProvider precisely so the
 * handshake ordering never wobbles. A provider whose probe THROWS counts as
 * available: a flaky check must never silently hide an integration.
 */
export function buildProviderCapabilities(): ProviderCapabilities {
  const availableProviders = hookProviders.filter((provider) => {
    if (!provider.isAvailable) return true;
    try {
      return provider.isAvailable();
    } catch {
      return true;
    }
  });
  const readingTools = new Set<string>();
  const subagentToolNames = new Set<string>();
  for (const provider of availableProviders) {
    for (const t of provider.readingTools) readingTools.add(t);
    for (const t of provider.subagentToolNames) subagentToolNames.add(t);
  }
  return {
    type: 'providerCapabilities',
    readingTools: [...readingTools],
    subagentToolNames: [...subagentToolNames],
    providers: availableProviders.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      // Additive field: the office only offers a provider in the launch
      // drawer when the server can actually spawn it (a view-only provider
      // has no buildLaunchCommand; an older webview ignores this field).
      launchable: typeof p.buildLaunchCommand === 'function',
    })),
  };
}
