import * as fs from 'fs';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CONTEXT_SEED_TAIL_BYTES,
  CONTEXT_WINDOW_TIERS,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from './constants.js';
import type { AgentState } from './types.js';

/**
 * How full an agent's context window is — the context gauge above every character.
 *
 * The number is a SNAPSHOT of the newest turn, never a running total: an
 * agent's context is whatever the last request carried, so it drops when the
 * session compacts or clears. Cached prompt tokens dominate that figure
 * (`input_tokens` alone is usually single digits once caching kicks in), so
 * all three prompt counters are summed plus what the model just wrote.
 */
interface UsageBlock {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** Shape we care about; transcripts carry far more per record. */
interface TranscriptRecord {
  isSidechain?: boolean;
  message?: { model?: string; usage?: UsageBlock };
}

/**
 * Context size implied by one transcript record, or 0 when it says nothing.
 *
 * Zero covers three cases that all mean "no news": records without usage,
 * synthetic assistant messages (API errors, interrupts) which report all-zero
 * usage, and anything malformed. Callers treat 0 as "leave the gauge alone" —
 * a real context is never 0 once a turn has run.
 */
export function extractContextTokens(record: unknown): number {
  const usage = (record as TranscriptRecord | null)?.message?.usage;
  if (!usage || typeof usage !== 'object') return 0;
  const sum =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  return Number.isFinite(sum) && sum > 0 ? sum : 0;
}

/**
 * Window an observed context has to fit in, when nobody can name it.
 *
 * The provider's answer for the model is the real source (see
 * `HookProvider.contextWindowForModel`); this is the backstop for unrecognized
 * models and for windows larger than anything we know about. It only ever
 * widens: a context that doesn't fit proves the assumption too small, while a
 * context that shrinks proves nothing (a 900k session compacted to 20k is
 * still running in a 1M window).
 */
export function widenContextWindow(observed: number, current: number): number {
  const window = Math.max(current || 0, DEFAULT_MAX_CONTEXT_TOKENS);
  for (const tier of CONTEXT_WINDOW_TIERS) {
    if (tier >= observed) return Math.max(window, tier);
  }
  const largest = CONTEXT_WINDOW_TIERS[CONTEXT_WINDOW_TIERS.length - 1];
  return Math.max(window, Math.ceil(observed / largest) * largest);
}

function applyContextTokens(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  tokens: number,
  fromMainChain: boolean,
  declaredWindow: number | undefined,
): void {
  if (fromMainChain) agent.sawMainChainUsage = true;
  agent.contextTokens = tokens;
  // A named model wins over the running estimate -- switching models mid-session
  // genuinely changes the window, and the provider knows it while we're only
  // guessing from what we've seen.
  agent.maxContextTokens = widenContextWindow(tokens, declaredWindow ?? agent.maxContextTokens);
  agents.broadcast({
    type: 'agentContextUsage',
    id: agentId,
    contextTokens: agent.contextTokens,
    maxContextTokens: agent.maxContextTokens,
  });
}

/**
 * Fold one freshly-read transcript record into the agent's context gauge.
 *
 * Sidechain records are another agent's turn, but WHOSE depends on the file:
 * in a lead's transcript they're its sub-agents (older Claude formats inline
 * them) and must not move the lead's gauge; a teammate's own transcript is
 * sidechain top to bottom and would otherwise never report anything. So the
 * rule is positional — once this file has produced a main-chain turn, later
 * sidechain records belong to someone else.
 */
export function updateContextUsage(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
  provider?: HookProvider | null,
): void {
  const tokens = extractContextTokens(record);
  if (tokens <= 0) return;
  const isSidechain = (record as TranscriptRecord | null)?.isSidechain === true;
  if (isSidechain && agent.sawMainChainUsage) return;
  applyContextTokens(agentId, agent, agents, tokens, !isSidechain, windowFor(record, provider));
}

/** The provider's window for whichever model wrote this record. */
function windowFor(record: unknown, provider?: HookProvider | null): number | undefined {
  return provider?.contextWindowForModel?.((record as TranscriptRecord | null)?.message?.model);
}

/**
 * Seed the gauge from a transcript's tail when watching starts.
 *
 * Most agents are adopted or restored mid-session with `fileOffset` at
 * end-of-file, so streaming alone leaves them gauge-less until their next
 * turn — an office full of idle agents would show nothing. Reading the last
 * chunk backwards finds the newest usage record without replaying history.
 */
export function seedContextUsage(
  agentId: number,
  agents: AgentStateStore,
  provider?: HookProvider | null,
): void {
  const agent = agents.get(agentId);
  if (!agent || agent.contextTokens > 0 || !agent.jsonlFile) return;

  let text: string;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    const start = Math.max(0, stat.size - CONTEXT_SEED_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return;
    const fd = fs.openSync(agent.jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // A mid-file start lands inside a record; drop that fragment.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return; // unreadable transcript -- the stream will seed it on the next turn
  }

  // Newest first. Main-chain wins; sidechain is the fallback that makes
  // teammate transcripts (sidechain-only files) work.
  const lines = text.split('\n');
  let sidechain: { tokens: number; window: number | undefined } | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const tokens = extractContextTokens(record);
    if (tokens <= 0) continue;
    if ((record as TranscriptRecord).isSidechain === true) {
      sidechain ??= { tokens, window: windowFor(record, provider) };
      continue;
    }
    applyContextTokens(agentId, agent, agents, tokens, true, windowFor(record, provider));
    return;
  }
  if (sidechain) {
    applyContextTokens(agentId, agent, agents, sidechain.tokens, false, sidechain.window);
  }
}
