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

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated once by the `providerCapabilities` postMessage after `webviewReady`.
// Modules classifying tools (character animation, subagent creation gate) read
// from here instead of hardcoding Claude-specific tool names.

type ToolCapabilities = {
  readingTools: Set<string>;
  subagentToolNames: Set<string>;
};

const providerCaps = new Map<string, ToolCapabilities>();
let legacyCaps: ToolCapabilities = {
  readingTools: new Set(),
  subagentToolNames: new Set(),
};

export function setProviderCapabilities(caps: {
  readingTools: string[];
  subagentToolNames: string[];
  providers?: Array<{
    id: string;
    readingTools: string[];
    subagentToolNames: string[];
  }>;
}): void {
  legacyCaps = {
    readingTools: new Set(caps.readingTools),
    subagentToolNames: new Set(caps.subagentToolNames),
  };
  providerCaps.clear();
  for (const provider of caps.providers ?? []) {
    providerCaps.set(provider.id, {
      readingTools: new Set(provider.readingTools),
      subagentToolNames: new Set(provider.subagentToolNames),
    });
  }
}

function capabilities(providerId?: string): ToolCapabilities {
  return (providerId && providerCaps.get(providerId)) || legacyCaps;
}

export function isReadingToolName(name: string | null | undefined, providerId?: string): boolean {
  return typeof name === 'string' && capabilities(providerId).readingTools.has(name);
}

export function isSubagentToolName(name: string | null | undefined, providerId?: string): boolean {
  return typeof name === 'string' && capabilities(providerId).subagentToolNames.has(name);
}
