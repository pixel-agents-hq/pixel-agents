/**
 * Hermes-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Hermes
 * unless Hermes is the active provider.
 *
 * Adding another provider? Create its own `providers/<kind>/<name>/constants.ts`.
 */

/** Provider id used in the hook route path (`/api/hooks/hermes`). */
export const HERMES_PROVIDER_ID = 'hermes';

/**
 * Hook events to register in Hermes `config.yaml` `hooks.outbound`.
 *
 * Hermes fires these as plugin hooks, so outbound webhooks (and thus the
 * Pixel Agents server) receive them. Each maps to an AgentEvent in
 * `normalizeHookEvent` (see hermes.ts).
 *
 * `on_turn_complete` is intentionally NOT installed: in current Hermes it is a
 * context-engine observation method (agent/context_engine.py), not a
 * plugin-manager hook event, so an outbound webhook entry for it would be
 * rejected with a warning at registration. normalizeHookEvent still handles
 * the name defensively in case a future Hermes fires it on the wire.
 */
export const HERMES_HOOK_EVENTS = [
  'pre_tool_call',
  'post_tool_call',
  'on_session_start',
  'on_session_end',
  'subagent_start',
  'subagent_stop',
] as const;

/** Terminal name prefix used when launching Hermes in a terminal.
 *  Used by the extension to match terminals to agents for adoption. */
export const HERMES_TERMINAL_NAME_PREFIX = 'Hermes';

/**
 * Marker name written into the `hooks.outbound` entry so install/uninstall and
 * `areHooksInstalled` can identify Pixel Agents' own entry among other
 * outbound webhooks the user may have configured (CI notifiers, dashboards, …).
 */
export const HERMES_HOOK_TARGET_NAME = 'pixel-agents';

// ── Context windows (per model, in tokens) ──────────────────
//
// Hermes reports model ids from its provider config (model, provider) but
// never the context limit, so these are best-effort denominators behind the
// context gauge. Unknown ids return undefined and the runtime keeps its own
// estimate (widening if a context ever exceeds it). The small-window regex is
// deliberately conservative: guessing small for a large model pins every gauge
// red, while the reverse is a quiet under-read the runtime corrects.
/** Small/cheap model ids (flash/mini/nano/… variants). */
export const HERMES_SMALL_CONTEXT_WINDOW = 128_000;
/** Everything else we recognize runs the large window. */
export const HERMES_LARGE_CONTEXT_WINDOW = 200_000;
/** Model ids that run the small window. Everything else gets the large one. */
export const HERMES_SMALL_CONTEXT_MODEL_PATTERN = /flash|mini|nano|tiny|small|haiku|lite\b/i;
