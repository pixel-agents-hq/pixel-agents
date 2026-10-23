import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  CONFIG_FILE_NAME,
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  SERVER_JSON_DIR,
} from '../../../../constants.js';
import {
  APPROVALS_ENV,
  APPROVALS_WAIT_MS_ENV,
  PERMISSION_HOOK_WAIT_MS,
  PERMISSION_RESPONSE_MAX_BYTES,
  PERMISSION_WAIT_PATH,
} from '../../../../permissions/constants.js';
import { approvalsSwitchedOff } from '../../../../permissions/killSwitch.js';
import { answersForToolInput, QUESTION_TOOL_NAME } from '../../../../permissions/questions.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { LEGACY_SERVER_JSON_PATH, readLegacyServer, readRegistry } from './serverRegistry.js';

const CONFIG_JSON = path.join(os.homedir(), SERVER_JSON_DIR, CONFIG_FILE_NAME);

/**
 * CI / e2e diagnostic: when PIXEL_AGENTS_DEBUG_LOG is set, record the hook
 * script's outcome at every exit point. The hook delivery chain (spawn
 * claude-hook.js -> read the registry -> POST to every live server) is
 * otherwise 100% silent: every failure path resolves quietly, so a dropped
 * hook is invisible in CI. Logging here lets a failing run show exactly
 * where delivery dies (bad-stdin, no-server-json, per-server POST
 * error/timeout/status). Zero cost when the env var is unset.
 */
// Env var is the primary source, but it doesn't reliably reach this spawned
// process across platforms (macOS VS Code terminal profiles with
// inheritEnv:false, etc.). After reading the registry we fall back to a
// live server's `debugLog` field, which the server populated from the same
// env var.
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} HOOKSCRIPT ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

// ── Payload size ──────────────────────────────────────────────────────────
//
// The server rejects a body over MAX_HOOK_BODY_SIZE (64 KB) with 413, and a
// rejected event is lost: a tool row that never finishes, a push or PR the
// progress tracker never sees. Claude Code's payloads routinely exceed that:
// PostToolUse carries the tool's whole output (a large Read, long Bash output)
// and PreToolUse its whole input (a Write's content, an Edit's strings). So the
// payload is cut down before it is posted, keeping what the server reads.

/** Body budget: the server's limit less headroom. */
const MAX_BODY_BYTES = MAX_HOOK_BODY_SIZE - 4 * 1024; // 60 KB
/** tool_response: the server only searches it for the PR url `gh pr create`
 *  prints, so a few KB of text is all it needs. */
const MAX_RESPONSE_CHARS = 4 * 1024;
/** Of MAX_RESPONSE_CHARS, how much comes from the END of the output, where a
 *  chained `… && gh pr create` prints its url. The rest is the start. */
const RESPONSE_TAIL_CHARS = 1024;
/** Any one string in tool_input (or, as a last resort, elsewhere). Keys like
 *  file_path, command, pattern and url stay whole unless longer than this. */
const MAX_INPUT_STRING_CHARS = 2 * 1024;
/** Nesting walked inside tool_input; a deeper value too big to keep whole
 *  becomes truncated JSON text. */
const MAX_INPUT_DEPTH = 8;
const MAX_INPUT_ARRAY_ITEMS = 100;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function cutMarker(chars: number): string {
  return `…[${chars} chars truncated]…`;
}

/** The first `cap` chars of `text` (never half a surrogate pair), and a marker. */
function clipHead(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const end = isHighSurrogate(text.charCodeAt(cap - 1)) ? cap - 1 : cap;
  return text.slice(0, end) + cutMarker(text.length - end);
}

/** The start and the last `tail` chars of `text`, `cap` chars in all, with a
 *  marker between them. */
function clipHeadAndTail(text: string, cap: number, tail: number): string {
  if (text.length <= cap) return text;
  let end = cap - tail;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
  let start = text.length - tail;
  if (isLowSurrogate(text.charCodeAt(start))) start++;
  return text.slice(0, end) + cutMarker(start - end) + text.slice(start);
}

/** tool_response unchanged when its text fits MAX_RESPONSE_CHARS, else that
 *  text (the string, or the value as JSON) cut to MAX_RESPONSE_CHARS. */
function shrinkResponse(response: unknown): unknown {
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  if (text === undefined || text.length <= MAX_RESPONSE_CHARS) return response;
  return clipHeadAndTail(text, MAX_RESPONSE_CHARS, RESPONSE_TAIL_CHARS);
}

/** A copy of `value` with every string over MAX_INPUT_STRING_CHARS cut down
 *  (head only: a command's tail without its start can parse as a different
 *  command), arrays capped at MAX_INPUT_ARRAY_ITEMS and nesting at
 *  MAX_INPUT_DEPTH. Values within those bounds are kept as they are. */
function shrinkValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return clipHead(value, MAX_INPUT_STRING_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_INPUT_DEPTH) {
    const text = JSON.stringify(value);
    return text.length <= MAX_INPUT_STRING_CHARS ? value : clipHead(text, MAX_INPUT_STRING_CHARS);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_INPUT_ARRAY_ITEMS).map((item) => shrinkValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, shrinkValue(item, depth + 1)]),
  );
}

function fitsInBody(payload: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(payload)) <= MAX_BODY_BYTES;
}

/**
 * The hook payload to POST, cut down to fit the server's body limit while
 * keeping what the server reads. Pure: `data` is not modified.
 *  1. tool_response becomes at most MAX_RESPONSE_CHARS of text (its start and
 *     end), and each long string in tool_input is cut to its start. Every
 *     other field is untouched, and a payload already within these bounds
 *     comes back unchanged.
 *  2. Still too big (an input of very many strings): tool_input and
 *     tool_response are dropped. Delivering the event matters more.
 *  3. Still too big: another field no consumer reads (a failed tool's error
 *     output, say) is oversized, so every long string left is cut too.
 */
export function shrinkHookPayload(data: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...data };
  if (payload.tool_response !== undefined) {
    payload.tool_response = shrinkResponse(payload.tool_response);
  }
  if (payload.tool_input !== undefined) payload.tool_input = shrinkValue(payload.tool_input, 1);
  if (fitsInBody(payload)) return payload;

  delete payload.tool_response;
  delete payload.tool_input;
  if (fitsInBody(payload)) return payload;

  return shrinkValue(payload, 0) as Record<string, unknown>;
}

/**
 * POST one hook event to one server. Best-effort: every failure path (bad
 * connection, timeout, non-2xx status) resolves quietly -- a dropped delivery
 * to one server must never affect delivery to any other server, nor the
 * script's exit code.
 */
function postToServer(
  server: ServerTarget,
  body: string,
  eventName: string,
  sid: string,
): Promise<void> {
  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/claude`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: 2000,
        },
        (res) => {
          hookDebug(
            `POST-done event=${eventName} sid=${sid} status=${res.statusCode} port=${server.port}`,
          );
          res.resume();
          resolve();
        },
      );
      req.on('error', (err) => {
        hookDebug(
          `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err.message}`,
        );
        resolve();
      });
      req.on('timeout', () => {
        hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch (err) {
      hookDebug(
        `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`,
      );
      resolve();
    }
  });
}

// ── Approvals from the board ──────────────────────────────────────────────
//
// A PermissionRequest hook may answer the permission dialog Claude Code is
// already showing in the terminal. After the normal fan-out, the hook
// long-polls ONE standalone server, which shows the request on the board and
// holds it until someone answers there, the session moves on, or the wait
// runs out. Only an answer from the board prints anything; every other path
// (switched off, no server, timeout, error) exits 0 silently and the terminal
// dialog decides, exactly as without Pixel Agents.

/** Read ~/.pixel-agents/config.json as-is; undefined when absent/unparseable. */
function readPixelAgentsConfig(): unknown {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The server to wait on: the newest live standalone server (the board),
 *  else the newest live server of any kind. */
export function pickApprovalServer(registry: ServerConfig[]): ServerConfig | undefined {
  const newestFirst = [...registry].sort((a, b) => b.startedAt - a.startedAt);
  return newestFirst.find((s) => s.standalone !== undefined) ?? newestFirst[0];
}

/**
 * The exact stdout for a board answer, or null when the server's response is
 * not a valid decision. Built from scratch out of the validated fields, so
 * nothing else the server sent (an "always allow" rule, rewritten input) can
 * ever reach Claude Code. An AskUserQuestion is the one input the board may
 * fill in: its allow must carry answers, and `updatedInput` is this session's
 * OWN tool input plus the `answers` map built from it (questions.ts).
 */
export function permissionHookOutput(
  response: unknown,
  toolName?: unknown,
  toolInput?: unknown,
): string | null {
  if (response === null || typeof response !== 'object') return null;
  const decision = (response as { decision?: unknown }).decision;
  if (decision === null || typeof decision !== 'object') return null;
  const { behavior, message, answers } = decision as {
    behavior?: unknown;
    message?: unknown;
    answers?: unknown;
  };
  if (behavior !== 'allow' && behavior !== 'deny') return null;
  const out: {
    behavior: 'allow' | 'deny';
    message?: string;
    updatedInput?: Record<string, unknown>;
  } = { behavior };
  if (behavior === 'deny' && typeof message === 'string' && message.length > 0) {
    out.message = message.slice(0, 1000);
  }
  if (behavior === 'allow' && toolName === QUESTION_TOOL_NAME) {
    // "allow" alone answers nothing: no usable answers, no output.
    const map = answersForToolInput(toolInput, answers);
    if (!map) return null;
    out.updatedInput = { ...(toolInput as Record<string, unknown>), answers: map };
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: out },
  });
}

/** How long to wait on the board: PERMISSION_HOOK_WAIT_MS, or shorter when the
 *  test-only env var says so. */
function approvalWaitMs(): number {
  const override = Number(process.env[APPROVALS_WAIT_MS_ENV]);
  return Number.isFinite(override) && override > 0
    ? Math.min(override, PERMISSION_HOOK_WAIT_MS)
    : PERMISSION_HOOK_WAIT_MS;
}

/** Long-poll one server for this request's answer. Resolves the parsed JSON
 *  body of a 200 response, or null on any failure. Never rejects. */
function waitOnServer(server: ServerTarget, body: string, sid: string): Promise<unknown> {
  const waitMs = approvalWaitMs();
  hookDebug(`WAIT sid=${sid} port=${server.port} ms=${waitMs}`);
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    const deadline = setTimeout(() => {
      req?.destroy();
      done(null, 'timeout');
    }, waitMs);
    function done(value: unknown, why: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      hookDebug(`WAIT-done sid=${sid} port=${server.port} ${why}`);
      resolve(value);
    }
    try {
      req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: PERMISSION_WAIT_PATH,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            text += chunk;
            if (text.length > PERMISSION_RESPONSE_MAX_BYTES) {
              res.destroy();
              done(null, 'too-large');
            }
          });
          res.on('end', () => {
            if (res.statusCode !== 200) return done(null, `status=${res.statusCode}`);
            try {
              done(JSON.parse(text) as unknown, 'ok');
            } catch {
              done(null, 'bad-json');
            }
          });
          res.on('error', () => done(null, 'response-error'));
        },
      );
      req.on('error', (err) => done(null, `error=${err.message}`));
      req.end(body);
    } catch (err) {
      done(null, `error=${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** For a local PermissionRequest: wait on the board, and return what to print
 *  (null = print nothing, the terminal decides). */
async function boardDecision(
  data: Record<string, unknown>,
  registry: ServerConfig[],
  sid: string,
): Promise<string | null> {
  // A relayed remote session's event is never answered here (approvals are
  // local only); the hook should never even see one, but check anyway.
  if (data.pixel_source !== undefined) return null;
  if (approvalsSwitchedOff(process.env[APPROVALS_ENV], readPixelAgentsConfig())) {
    hookDebug(`WAIT-skip sid=${sid} reason=switched-off`);
    return null;
  }
  const server = pickApprovalServer(registry);
  if (!server) return null;
  const request = shrinkHookPayload({
    session_id: data.session_id,
    tool_name: data.tool_name,
    tool_input: data.tool_input,
    cwd: data.cwd,
  });
  const body = JSON.stringify({ ...request, requestId: randomUUID() });
  return permissionHookOutput(
    await waitOnServer(server, body, sid),
    data.tool_name,
    data.tool_input,
  );
}

/** Write to stdout and wait for it to flush (a pipe write can be async, and
 *  the process exits right after). */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  // Multi-server fan-out (D4): deliver to every live server in the registry.
  // Falls back to the single legacy server.json when the registry has no live
  // entries -- e.g. a server on disk that predates the registry (A1/A2).
  const registry = readRegistry(hookDebug);
  let servers: ServerTarget[] = registry;
  if (servers.length === 0) {
    try {
      servers = [readLegacyServer()];
    } catch (e) {
      hookDebug(
        `exit reason=no-server-json event=${eventName} sid=${sid} path=${LEGACY_SERVER_JSON_PATH} err=${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(0);
    }
  }

  // Adopt the first live server's debug-log path if the env var didn't reach
  // us (diagnostic-only; harmless if more than one server has it set).
  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => s.debugLog);
    if (withDebugLog?.debugLog) debugLogPath = withDebugLog.debugLog;
  }

  const body = JSON.stringify(shrinkHookPayload(data));
  if (Buffer.byteLength(input) > MAX_BODY_BYTES) {
    hookDebug(
      `shrunk event=${eventName} sid=${sid} bytes=${Buffer.byteLength(input)}->${Buffer.byteLength(body)}`,
    );
  }
  await Promise.all(servers.map((server) => postToServer(server, body, eventName, sid)));

  if (eventName === 'PermissionRequest') {
    const output = await boardDecision(data, registry, sid);
    if (output) await writeStdout(output);
  }
}

// Run only as the hook script itself (the bundled CJS entry), not when a test
// imports this module for shrinkHookPayload.
if (require.main === module) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
