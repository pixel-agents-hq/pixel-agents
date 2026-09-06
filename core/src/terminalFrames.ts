/**
 * Terminal data-plane framing, shared by the server route and the browser
 * client. Deliberately outside the AsyncAPI contract: this is a raw byte
 * stream, not control-plane state (see docs/design/standalone-terminal.md,
 * "Transport: why raw I/O is outside AsyncAPI").
 *
 * Pure functions over plain values, no runtime dependencies -- `core/` is the
 * one layer both `server/` and `webview-ui/` may import, which is what makes
 * this the single definition of the wire shape rather than one per side.
 * Both parsers validate structurally and return null for anything else: each
 * direction is attacker-reachable (a WebSocket), so nothing is trusted to be
 * well-formed.
 */

/** server → client */
export type TerminalServerFrame =
  /** First frame on every attach: a serialized snapshot of the mirrored screen,
   *  plus the PTY geometry it was laid out at. The client resets, resizes to
   *  cols×rows, and writes `data` to reproduce the screen exactly. */
  | { type: 'replay'; data: string; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number };

/** client → server */
export type TerminalClientFrame =
  { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

export function encodeTerminalFrame(frame: TerminalServerFrame | TerminalClientFrame): string {
  return JSON.stringify(frame);
}

export function parseClientFrame(raw: string): TerminalClientFrame | null {
  const frame = parseObject(raw);
  if (!frame) return null;
  if (frame.type === 'input') {
    return typeof frame.data === 'string' ? { type: 'input', data: frame.data } : null;
  }
  if (frame.type === 'resize') {
    const { cols, rows } = frame;
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return null;
    return { type: 'resize', cols, rows };
  }
  return null;
}

export function parseServerFrame(raw: string): TerminalServerFrame | null {
  const frame = parseObject(raw);
  if (!frame) return null;
  if (frame.type === 'output') {
    return typeof frame.data === 'string' ? { type: 'output', data: frame.data } : null;
  }
  if (frame.type === 'replay') {
    const { data, cols, rows } = frame;
    if (typeof data !== 'string' || !isPositiveInt(cols) || !isPositiveInt(rows)) return null;
    return { type: 'replay', data, cols, rows };
  }
  if (frame.type === 'exit') {
    if (typeof frame.exitCode !== 'number') return null;
    return typeof frame.signal === 'number'
      ? { type: 'exit', exitCode: frame.exitCode, signal: frame.signal }
      : { type: 'exit', exitCode: frame.exitCode };
  }
  return null;
}

function parseObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as Record<string, unknown>;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
