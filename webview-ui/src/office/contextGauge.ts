/**
 * Agents' context gauges, shared by the label over each character
 * (ToolOverlay) and the bar along the foot of each agent card (AgentCard).
 * The fill is the context LEFT, like a health bar; the colour warns by the
 * share used, in the steps of the user's Claude Code status line.
 */

import { useSyncExternalStore } from 'react';

import {
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_RED,
  CONTEXT_GAUGE_COLOR_YELLOW,
  CONTEXT_RED_THRESHOLD,
  CONTEXT_YELLOW_THRESHOLD,
} from '../constants.js';

/** The gauge colour for a share of the context used (0-1). */
export function contextColor(usedRatio: number): string {
  if (usedRatio > CONTEXT_RED_THRESHOLD) return CONTEXT_GAUGE_COLOR_RED;
  if (usedRatio >= CONTEXT_YELLOW_THRESHOLD) return CONTEXT_GAUGE_COLOR_YELLOW;
  return CONTEXT_GAUGE_COLOR_OK;
}

/** Share of the context left (0-1), what the gauge fills: a health bar. */
export function contextLeft(usedRatio: number): number {
  return Math.max(0, 1 - usedRatio);
}

/**
 * The share of the context used (0-1) that an agentContextUsage reports, or
 * null when it says nothing usable. 0 tokens is a real reading — the session
 * was just cleared — and shows as a full gauge: the server never sends the
 * meaningless all-zero usage records.
 */
export function contextUsedShare(contextTokens: number, maxTokens: number): number | null {
  if (!Number.isFinite(contextTokens) || contextTokens < 0 || !(maxTokens > 0)) return null;
  return Math.min(1, contextTokens / maxTokens);
}

// Each agent's share used, as the latest agentContextUsage said (the server
// re-sends them on every connect). React reads it per card, so a card
// re-renders when its own agent's context moves.
const usedById = new Map<number, number>();
const listeners = new Set<() => void>();

/** Record an agentContextUsage (useExtensionMessages). */
export function setAgentContextUsed(id: number, contextTokens: number, maxTokens: number): void {
  const used = contextUsedShare(contextTokens, maxTokens);
  if (used === null || usedById.get(id) === used) return;
  usedById.set(id, used);
  for (const l of listeners) l();
}

/** Forget a closed agent's context (useExtensionMessages' closeAgent). */
export function clearAgentContextUsed(id: number): void {
  if (!usedById.delete(id)) return;
  for (const l of listeners) l();
}

/** An agent's share of context used (0-1), or null when none was reported. */
export function agentContextUsed(id: number): number | null {
  return usedById.get(id) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** An agent's share of context used (0-1), or null before its first turn. */
export function useAgentContextUsed(id: number): number | null {
  return useSyncExternalStore(subscribe, () => agentContextUsed(id));
}
