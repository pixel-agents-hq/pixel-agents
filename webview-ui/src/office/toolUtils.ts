import { ZOOM_DEFAULT_DPR_FACTOR, ZOOM_MIN } from '../constants.js';

/** Map status prefixes back to tool names for animation selection */
const STATUS_TO_TOOL: Record<string, string> = {
  Reading: 'Read',
  Searching: 'Grep',
  Globbing: 'Glob',
  Fetching: 'WebFetch',
  'Searching web': 'WebSearch',
  Writing: 'Write',
  Editing: 'Edit',
  Running: 'Bash',
  Task: 'Task',
};

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool;
  }
  const first = status.split(/[\s:]/)[0];
  return first || null;
}

/** Compute a default integer zoom level (device pixels per sprite pixel) */
export function defaultZoom(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr));
}

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated once by the `providerCapabilities` postMessage after `webviewReady`.
// Modules classifying tools (character animation, subagent creation gate) read
// from here instead of hardcoding Claude-specific tool names.

const providerCaps: {
  readingTools: Set<string>;
  subagentToolNames: Set<string>;
} = {
  readingTools: new Set(),
  subagentToolNames: new Set(),
};

export function setProviderCapabilities(caps: {
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCaps.readingTools = new Set(caps.readingTools);
  providerCaps.subagentToolNames = new Set(caps.subagentToolNames);
}

export function isReadingToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.readingTools.has(name);
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.subagentToolNames.has(name);
}
