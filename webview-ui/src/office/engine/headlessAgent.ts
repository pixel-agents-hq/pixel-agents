// webview-ui/src/office/engine/headlessAgent.ts
//
// Pure decision for whether an agent's character renders as headless (the
// translucent "ghost" cue for an agent with no terminal to focus). Extracted
// so it's directly unit-testable, mirroring existingAgents.ts / officeCanvasCursor.ts
// (the deliberate e2e-over-unit policy forbids unit tests against the React
// message handler itself).

/**
 * A Headless agent is one the office adopted from outside (`claude -p`, a session
 * picked up by Watch All Sessions) and therefore has no terminal to focus. Its
 * character renders translucent so it reads as untouchable at a glance.
 *
 * `explicitHeadless` is the wire-level override (AgentCreated.isHeadless /
 * ExistingAgents.headlessAgents, core/asyncapi.yaml) that lets a producer state
 * this outright, taking priority over the heuristic below. Without it, a
 * third-party backend implementing this protocol (e.g. a Discord bridge running
 * its own standalone-shaped server) has no way to mark its agents headless: the
 * `!isBrowserRuntime` heuristic exists for OUR standalone/dev-preview surface,
 * where every agent is externally-driven and the cue would distinguish nothing
 * — but that reasoning doesn't hold for a third party's browser client, where
 * some agents may be real coding sessions and others mirrored/adopted ones.
 */
export function resolveHeadless(
  isExternal: boolean | undefined,
  explicitHeadless: boolean | undefined,
  isBrowserRuntime: boolean,
): boolean {
  return explicitHeadless ?? (isExternal === true && !isBrowserRuntime);
}
