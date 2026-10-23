import {
  PERMISSION_DETAIL_CHANGE_LINES,
  PERMISSION_DETAIL_MAX_CHARS,
  PERMISSION_LOG_DETAIL_MAX_CHARS,
} from './constants.js';

/** Tools whose input is a shell command: the card shows the whole command. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools that change a file: the card shows its path and the start of the change. */
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** `text` cut to `max` chars, never splitting a surrogate pair, with a visible
 *  marker saying how much is hidden. An approval card must never show a cut
 *  command as if it were the whole command. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}…[${text.length - end} more chars]`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstLines(text: string, lines: number): string {
  const all = text.split('\n');
  if (all.length <= lines) return text;
  return `${all.slice(0, lines).join('\n')}\n…[${all.length - lines} more lines]`;
}

/** The change an Edit/Write/MultiEdit/NotebookEdit makes, as text. */
function fileChange(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Write') return str(input.content) ?? '';
  if (tool === 'NotebookEdit') return str(input.new_source) ?? '';
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits
      .map((e) => {
        const edit = (e ?? {}) as Record<string, unknown>;
        return `- ${str(edit.old_string) ?? ''}\n+ ${str(edit.new_string) ?? ''}`;
      })
      .join('\n');
  }
  const oldText = str(input.old_string);
  const newText = str(input.new_string) ?? '';
  return oldText === undefined ? newText : `- ${oldText}\n+ ${newText}`;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * What the approval card shows for one request: the thing that would run, as
 * fully as fits. Bash/PowerShell → the command; Edit/Write/MultiEdit → the
 * file path and the first lines of the change; WebFetch → the URL; anything
 * else (MCP tools, ...) → the tool name and its input as compact JSON. Every
 * shape is capped at PERMISSION_DETAIL_MAX_CHARS with a visible marker.
 */
export function formatPermissionDetail(tool: string, toolInput: unknown): string {
  const input =
    toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {};
  let detail: string;
  if (SHELL_TOOLS.has(tool) && str(input.command) !== undefined) {
    detail = str(input.command)!;
  } else if (FILE_EDIT_TOOLS.has(tool) && (str(input.file_path) ?? str(input.notebook_path))) {
    const filePath = str(input.file_path) ?? str(input.notebook_path)!;
    const change = firstLines(fileChange(tool, input), PERMISSION_DETAIL_CHANGE_LINES);
    detail = change ? `${filePath}\n\n${change}` : filePath;
  } else if (tool === 'WebFetch' && str(input.url) !== undefined) {
    detail = str(input.url)!;
  } else {
    detail = `${tool} ${compactJson(toolInput ?? {})}`;
  }
  return capText(detail, PERMISSION_DETAIL_MAX_CHARS);
}

/** One short line of the detail for approvals.log: newlines folded, capped. */
export function shortPermissionDetail(detail: string): string {
  return capText(detail.replace(/\s*\n\s*/g, ' ⏎ '), PERMISSION_LOG_DETAIL_MAX_CHARS);
}
