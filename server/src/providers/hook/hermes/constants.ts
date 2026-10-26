/**
 * Hermes-specific constants. Kept separate from `server/src/constants.ts` per
 * the multi-provider convention: a single-provider build must not pull another
 * provider's facts in by accident.
 *
 * Hermes facts mirror the upstream wire contract in
 * `agent/outbound_webhooks.py` + `agent/shell_hooks.py` (Hermes Agent
 * v0.21.7): the outbound-webhook POST body is
 * `{ hook_event_name, profile, tool_name, tool_input, session_id, cwd,
 *    extra, delivery_id, timestamp }`, delivered with fixed headers
 * (`X-Hermes-Event`, `X-Hermes-Delivery`, optional
 * `X-Hermes-Signature-256`) — there is NO way to attach an
 * `Authorization` header, which is why the hook route must accept the server
 * token as a `?token=` query for this provider (see httpServer.ts).
 */

/** Hermes has no bundled hook script at all: its outbound-webhook subsystem
 *  reads targets straight from config.yaml, so there is nothing to copy to
 *  disk and the install footprint is provably just the one entry managed by
 *  hermesHookInstaller.ts. */

/** The `hooks.outbound` events we subscribe to. This list is the whole
 *  data-collection surface (same rule as CLAUDE_HOOK_EVENTS): an event we do
 *  not act on is scope we should not ask for.
 *
 *   on_session_start    → sessionStart (adopts the session as a pending
 *                         external session; carries cwd for Directory mapping)
 *   pre_tool_call       → toolStart (typing/reading animation, status line)
 *   post_tool_call      → toolEnd (character returns to idle)
 *   on_human_input_request → turnEnd{awaitingInput} — the "Waiting for input"
 *                         bubble (Hermes' analogue of Claude's
 *                         Notification(idle_prompt): a tool is blocked on the
 *                         human, e.g. MCP elicitation / vault payment)
 *   on_session_end      → turnEnd — fires PER TURN at the end of
 *                         `run_conversation()` (one turn per user message on
 *                         every surface), NOT only at session close. Carries
 *                         completed/failed/interrupted + platform in `extra`,
 *                         and since the per-turn usage snapshot also the last
 *                         response's token totals + resolved window there
 *                         (`usage`/`context_length`, integers only) — the
 *                         gauge data for this push-only provider.
 *   on_session_finalize → sessionEnd (the session is closing; retires the
 *                         character the way Claude's SessionEnd does)
 *   pre_approval_request  → permissionRequest (the "Needs approval" bubble;
 *                         Hermes' analogue of Claude's PermissionRequest hook)
 *   post_approval_response → permissionResolved (the human answered at the
 *                         CLI surface — approve/deny/timeout all clear the
 *                         bubble; Claude has no such hook and clears via its
 *                         JSONL watcher instead)
 *
 *  Approval routing fact (verified against the live envelope builder):
 *  `tools/approval_context._fire_approval_hook` promotes the bound
 *  observability-context session_id into the hook kwargs, and
 *  `agent/outbound_webhooks._serialize_payload` puts it at the envelope's
 *  top level — approval events are routable like tool events. Approval sites
 *  that fire WITHOUT a bound context post an empty session_id and are
 *  dropped by normalizeHookEvent's guard: a bubble without an owner never
 *  happens.
 *
 *  Deliberately NOT subscribed:
 *   - post_llm_call: also fires per turn, but `agent/turn_finalizer.py` passes
 *     `conversation_history=list(messages)` into the payload — subscribing
 *     would serialize the whole transcript to the endpoint on every turn,
 *     orders of magnitude more data than the office can act on. The per-turn
 *     signal we need already comes from on_session_end at near-zero cost.
 *   - agent_loop_stopped: its kwargs carry only `session_key` (no
 *     `session_id`), so it is not routable — and the office has no action
 *     for it either: the loop stop surfaces as the following turn/session
 *     events.
 *   - subagent_start / subagent_stop: Hermes sub-agents (delegate_task
 *     children) run real top-level sessions that fire their own lifecycle and
 *     tool hooks, so the office adopts each as its own character. Claude's
 *     ghost-sub-agent model (a subagent visual under the lead, no session of
 *     its own) does not fit; subscribing would double-render every child. */
export const HERMES_HOOK_EVENTS = [
  'on_session_start',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'on_human_input_request',
  'on_session_end',
  'on_session_finalize',
] as const;

/** Wire identity of our subscription inside ~/.hermes/config.yaml's
 *  `hooks.outbound`: the entry name we write, recognized alongside the url
 *  suffix so a hand-edited or renamed entry is still adopted on reinstall. */
export const HERMES_OUTBOUND_ENTRY_NAME = 'pixel-agents';

/** URL path (appended to the server base) carrying our provider id and the
 *  server token as a query credential (Hermes cannot send a Bearer header).
 *  Matching is anchored at both ends the way the Claude installer anchors its
 *  hook-script path: a suffix collision must not make us claim a foreign
 *  entry, and a prefix of it must not be mistaken for ours. */
export const HERMES_HOOK_URL_PATH = '/api/hooks/hermes';

/** Suffix of the one-time pre-modification backup of config.yaml. Brand-named
 *  for the same reason as the Claude one: a foreign `.backup` must never make
 *  us believe we already saved the user's original. */
export const HERMES_CONFIG_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file for the atomic tmp-write + rename. */
export const HERMES_CONFIG_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for a config.yaml we create ourselves (token-bearing file, so the
 *  restrictive default; an existing file's mode is preserved). */
export const HERMES_CONFIG_FRESH_FILE_MODE = 0o600;

/** Attempts for the config.yaml read-modify-write cycle. Hermes itself writes
 *  this file (`hermes config set`, the setup wizard, /sethome) without
 *  coordinating with us, so — exactly like the Claude installer — we re-read
 *  immediately before committing and retry when the file changed. Narrowed,
 *  not eliminated: the same lost-update window analysis applies. */
export const HERMES_CONFIG_MUTATE_ATTEMPTS = 3;
/** Delay between mutation attempts (lets a concurrent writer finish). */
export const HERMES_CONFIG_MUTATE_RETRY_DELAY_MS = 100;

/** Per-attempt delivery timeout (seconds) written into the target entry.
 *  Hermes clamps to [1, 60]; a dead pixel-agents server must delay a delivery
 *  worker, never a tool call. The queue is fire-and-forget (256 deep, drops
 *  when full), so even a wedged office can only cost dropped events. */
export const HERMES_HOOK_TIMEOUT_SECONDS = 5;

/** Terminal name prefix used when launching Hermes in VS Code (future +Agent
 *  support; declared now so the extension's heuristic can match user-named
 *  terminals). */
export const HERMES_TERMINAL_NAME_PREFIX = 'Hermes';

/** Extra.platform values whose sessions the provider drops even when they
 *  carry a session_id: scheduled/unattended runs (cron jobs, batch scoring)
 *  share the machine's config and would otherwise flood the office with
 *  characters nobody is watching. Interactive surfaces — cli, tui, desktop,
 *  gateway platforms like telegram/discord — are all kept.
 *
 *  'subagent' is in the wire set because delegate_task CHILDREN fire their own
 *  lifecycle as top-level sessions: rendering each as a full character would
 *  double every delegated task on the desk. They are NOT invisible either —
 *  the SESSION-STORE SCANNER correlates them with their parent
 *  (sessions.parent_session_id) and renders each as a Subtask sub-character
 *  near the lead, like Claude's Task-tool subagents. That correlation only
 *  exists in the store (the wire envelope carries the child's id, never the
 *  parent's), which is why the sub-character path is scanner-driven and this
 *  filter stays closed on the wire. */
export const HERMES_SILENT_PLATFORMS: ReadonlySet<string> = new Set(['cron', 'batch', 'subagent']);

/** Scanner-only: sessions.source values of the live `sessions` table the
 *  scanner never ADOPTS as characters. 'subagent' is not here because child
 *  rows are discriminated structurally by parent_session_id, not by source
 *  (they inherit the parent's source!). 'oneshot' = transient single-query
 *  runs (`hermes chat -q`), 'unknown' = rows whose provenance cannot be
 *  attributed; both would only ever add noise. */
export const HERMES_SCANNER_SILENT_SOURCES: ReadonlySet<string> = new Set([
  'cron',
  'batch',
  'oneshot',
  'unknown',
]);

/** The union of both silent gates MINUS 'subagent'. An operator can opt into
 *  seeing scheduled/transient/unattributable runs; they cannot opt into a
 *  delegate_task child as a second full character, because the child fires its
 *  own lifecycle on the wire while the scanner already renders it as a Subtask
 *  sub-character under its parent — the toggle would double-render it, not
 *  reveal something hidden. So 'subagent' stays structural, outside the switch. */
export const HERMES_TOGGLEABLE_SILENT_SOURCES: ReadonlySet<string> = new Set(
  [...HERMES_SILENT_PLATFORMS, ...HERMES_SCANNER_SILENT_SOURCES].filter((s) => s !== 'subagent'),
);

/** Provider-owned visibility ref, the Hermes counterpart of the runtime's
 *  `watchAllSessions`: the SETTING persists per surface (config.json namespaces
 *  `vscode`/`standalone`), the DROP decision stays a provider concern. Read by
 *  ONE predicate both gates share, so the wire (platform) and the store (source)
 *  can never disagree about what "silent" means. */
let silentSessionsShown = false;

export function setSilentSessionsShown(show: boolean): void {
  silentSessionsShown = show;
}

export function areSilentSessionsShown(): boolean {
  return silentSessionsShown;
}

export function isSilentSource(value: string | undefined): boolean {
  if (!value) return false;
  if (value === 'subagent') return true;
  return HERMES_TOGGLEABLE_SILENT_SOURCES.has(value) && !silentSessionsShown;
}

/** Grace before a desk-held session with NO lease row at all is treated as
 *  dead. While a Hermes process lives it keeps its lease, and Hermes' own
 *  registry janitor prunes entries whose pid is gone — so an absent lease on
 *  a character the desk still holds is death judged by the store itself. The
 *  delay only covers the race where a lease has been re-acquired (or pruned)
 *  between two of our ticks; a lease that reappears cancels the verdict. */
export const HERMES_SCANNER_ORPHAN_GRACE_MS = 90_000;

/** A session younger than this may simply not have written its lease yet, so
 *  its absence proves nothing and the orphan clock never starts. */
export const HERMES_SCANNER_LEASE_REGISTER_GRACE_MS = 60_000;

// ── Session-store scanner timing ─────────────────────────────────────

/** Scanner poll period. Liveness (ghost reaping after a non-graceful kill)
 *  and hook-less adoption both become visible within one tick; the store
 *  queries are single-digit-millisecond indexed reads, so 5 s costs nothing
 *  while keeping the desk responsive. */
export const HERMES_SCANNER_INTERVAL_MS = 5_000;

/** Message rows replayed per session per tick. Bounds catch-up after a
 *  server restart with live sessions; steady state is a handful of rows. */
export const HERMES_SCANNER_REPLAY_LIMIT = 50;

/** Cap for directory suggestions pulled from the session store (the modal
 *  shows far fewer after dedupe; this only bounds the query). */
export const HERMES_SCANNER_SUGGESTION_LIMIT = 100;

/** Wire name of the scanner's sub-agent spawn event. NOT a Hermes hook —
 *  it exists only between hermesSessionScanner and this provider's
 *  normalizeHookEvent (never leaves the process). `session_id` addresses
 *  the PARENT; `subagent_session_id` is the child's own session id, used as
 *  the stable sub-character id. */
export const HERMES_SCANNER_SUBAGENT_START_EVENT = 'subagent_session_start';
export const HERMES_SCANNER_SUBAGENT_END_EVENT = 'subagent_session_end';

/** sessionEnd reason the scanner synthesizes when the store proves a
 *  session dead (ended_at appeared, or its lease pid is gone). Distinct
 *  from Hermes' own finalize reasons so logs show WHO retired the character;
 *  deliberately NOT 'clear'/'resume', the two values that put the handler
 *  into the follow-up-waiting branch. */
export const HERMES_SCANNER_REAP_REASON = 'scanner-expired';

/** How many announced deaths the scanner remembers by session id. "Reap
 *  once" cannot live in the per-session watch: that bookkeeping is dropped
 *  the moment the death lands, and a SIGKILLed session's ROW stays live in
 *  the store forever (ended_at is only written by a graceful finalize), so
 *  the dead-but-unburied row would be re-reaped on every tick. Ids are never
 *  reused, so a bounded FIFO of them is a sufficient memory. */
export const HERMES_SCANNER_REAP_TOMBSTONES = 500;

/** Prefix Hermes titles its delegate_task children with ('Subagent: <goal>').
 *  Trimmed off for the sub-character status line. */
export const HERMES_SUBAGENT_TITLE_PREFIX = 'Subagent: ';

/** Max length of the child's goal text shown in the Subtask status line. */
export const HERMES_SCANNER_SUBAGENT_TITLE_MAX = 60;
