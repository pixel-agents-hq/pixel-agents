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

// ── Tool props (the small item drawn above-right of a working character) ────

export const ToolProp = {
  MAGNIFIER: 'magnifier',
  PENCIL: 'pencil',
  WRENCH: 'wrench',
  BOOK: 'book',
  FOLDER: 'folder',
  MARKER: 'marker',
  QUESTION: 'question',
  STAMP: 'stamp',
  CLIPBOARD: 'clipboard',
} as const;
export type ToolProp = (typeof ToolProp)[keyof typeof ToolProp];

/** Exact tool names, checked before the provider's reading set and the patterns. */
const TOOL_PROP_BY_NAME: Record<string, ToolProp> = {
  Read: ToolProp.MAGNIFIER,
  Grep: ToolProp.MAGNIFIER,
  Glob: ToolProp.MAGNIFIER,
  LS: ToolProp.MAGNIFIER,
  Edit: ToolProp.PENCIL,
  Write: ToolProp.PENCIL,
  MultiEdit: ToolProp.PENCIL,
  NotebookEdit: ToolProp.PENCIL,
  Bash: ToolProp.WRENCH,
  BashOutput: ToolProp.WRENCH,
  KillShell: ToolProp.WRENCH,
  KillBash: ToolProp.WRENCH,
  PowerShell: ToolProp.WRENCH,
  WebFetch: ToolProp.BOOK,
  WebSearch: ToolProp.BOOK,
  Agent: ToolProp.FOLDER,
  Task: ToolProp.FOLDER,
  SendMessage: ToolProp.FOLDER,
  EnterPlanMode: ToolProp.MARKER,
  ExitPlanMode: ToolProp.MARKER,
  TodoWrite: ToolProp.MARKER,
  AskUserQuestion: ToolProp.QUESTION,
};

/** Name patterns for tools outside the table (other CLIs, MCP tools). */
const TOOL_PROP_PATTERNS: Array<[RegExp, ToolProp]> = [
  [/shell|bash|terminal|exec|command/i, ToolProp.WRENCH],
  [/plan|todo/i, ToolProp.MARKER],
  [/question|ask_?user/i, ToolProp.QUESTION],
];

/** The prop for a tool name; anything unrecognised gets the clipboard. */
export function toolPropForTool(toolName: string | null | undefined): ToolProp {
  if (!toolName) return ToolProp.CLIPBOARD;
  const exact = TOOL_PROP_BY_NAME[toolName];
  if (exact) return exact;
  for (const [pattern, prop] of TOOL_PROP_PATTERNS) {
    if (pattern.test(toolName)) return prop;
  }
  if (isReadingToolName(toolName)) return ToolProp.MAGNIFIER;
  return ToolProp.CLIPBOARD;
}

/**
 * The prop a character shows right now, or null for none. A bubble wins over
 * the tool: permission asks (question mark), a finished turn is stamped.
 */
export function toolPropFor(ch: {
  isActive: boolean;
  currentTool: string | null;
  bubbleType: 'permission' | 'waiting' | null;
}): ToolProp | null {
  if (ch.bubbleType === 'permission') return ToolProp.QUESTION;
  if (ch.bubbleType === 'waiting') return ToolProp.STAMP;
  if (!ch.isActive || !ch.currentTool) return null;
  return toolPropForTool(ch.currentTool);
}
