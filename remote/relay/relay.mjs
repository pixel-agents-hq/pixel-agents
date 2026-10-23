#!/usr/bin/env node
// Pixel Agents remote relay: the only process exposed to the internet (via
// Tailscale Funnel). It accepts Claude Code hook events from other computers and
// cloud sessions, authenticates them per source, strips them down, and forwards
// them to the Pixel Agents server on this machine over loopback. A sender's
// PermissionRequest may also wait here for an answer from the board (approvals).
// The server's own token never leaves this machine. See docs/remote/DESIGN.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PORT = 3199;
const MAX_INPUT_STRING = 300;
const MAX_INPUT_DEPTH = 4;
const FORWARD_TIMEOUT_MS = 2_000;
const MAX_QUEUED_FORWARDS = 500;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SOURCE_KINDS = new Set(['computer', 'cloud']);
const INGEST_PATHS = new Set(['/', '/ingest']);
// A sender's PermissionRequest long-poll, with or without the Funnel mount path.
const PERMISSION_PATHS = new Set(['/permission', '/ingest/permission']);
// The board's long-poll route and limits (server/src/permissions/constants.ts).
const BOARD_WAIT_PATH = '/api/permissions/wait';
const BOARD_WAIT_TIMEOUT_MS = 10.5 * 60 * 1000;
const BOARD_RESPONSE_MAX_BYTES = 16 * 1024;
// What the board sees of a waiting request's tool_input: enough to show the
// command and an AskUserQuestion's options (the activity events get less).
const WAIT_INPUT_LIMITS = { maxString: 2_000, maxDepth: 8, maxItems: 100 };
const MAX_WAIT_BODY_BYTES = 60 * 1024;
// Waits held open at once; past this a request gets no answer (the sender's
// terminal decides), so a leaked key can't pile up connections.
export const MAX_PERMISSION_WAITS = 32;
// The sender's PermissionRequest hook: curl gives up a little before Claude
// Code's timeout for the hook, both after the board's own 10-minute expiry.
const SENDER_WAIT_CURL_SECONDS = 650;
const SENDER_WAIT_HOOK_TIMEOUT_SECONDS = 660;
const QUESTION_TOOL_NAME = 'AskUserQuestion';
const QUESTION_MAX_QUESTIONS = 8;
const QUESTION_MAX_OPTIONS = 20;
const QUESTION_OTHER_MAX_CHARS = 2_000;
// A sender's status line input (the usage meter), with or without the mount path.
const USAGE_PATHS = new Set(['/usage', '/ingest/usage']);
// The board's usage route (server/src/constants.ts USAGE_API_PATH).
const BOARD_USAGE_PATH = '/api/usage';
// The sender's status line: curl gives up fast, and prints nothing on failure.
const SENDER_USAGE_CURL_SECONDS = 3;
const MAX_MODEL_NAME_CHARS = 60;
// Fields that point at files on the sender's machine or carry bulky tool output.
// pr_url is only ever set by the relay itself (see prUrlOf).
const DROPPED_FIELDS = ['transcript_path', 'agent_transcript_path', 'tool_response', 'pr_url'];
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const GITHUB_PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

// ── Config ──────────────────────────────────────────────────────────────────

function configPath(home) {
  return path.join(home, '.pixel-agents', 'relay.json');
}

export function loadConfig(home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(home), 'utf-8'));
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    return {
      port: Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT,
      sources: sources.filter(
        (s) =>
          s &&
          SOURCE_ID.test(s.id) &&
          SOURCE_KINDS.has(s.kind) &&
          typeof s.label === 'string' &&
          /^[0-9a-f]{64}$/.test(s.keyHash),
      ),
    };
  } catch {
    return { port: DEFAULT_PORT, sources: [] };
  }
}

function saveConfig(home, config) {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Create or replace a source. Returns its new key; only the hash is stored. */
export function addSource(home, { id, label = id, kind }) {
  if (!SOURCE_ID.test(id ?? '')) throw new Error(`invalid source id "${id}" (a-z, 0-9, -)`);
  if (!SOURCE_KINDS.has(kind)) throw new Error(`invalid kind "${kind}" (computer or cloud)`);
  if (typeof label !== 'string' || !label.trim() || label.length > 40) {
    throw new Error('label must be 1-40 characters');
  }
  const key = `pxr_${crypto.randomBytes(32).toString('base64url')}`;
  const config = loadConfig(home);
  const sources = config.sources.filter((s) => s.id !== id);
  sources.push({ id, label: label.trim(), kind, keyHash: hashKey(key) });
  saveConfig(home, { ...config, sources });
  return key;
}

export function removeSource(home, id) {
  const config = loadConfig(home);
  const sources = config.sources.filter((s) => s.id !== id);
  if (sources.length === config.sources.length) return false;
  saveConfig(home, { ...config, sources });
  return true;
}

/** The source a key belongs to, or null. Compares hashes in constant time. */
export function findSource(config, key) {
  if (typeof key !== 'string' || !key.startsWith('pxr_')) return null;
  const candidate = Buffer.from(hashKey(key), 'hex');
  let match = null;
  for (const s of config.sources) {
    if (crypto.timingSafeEqual(candidate, Buffer.from(s.keyHash, 'hex'))) match = s;
  }
  return match ? { id: match.id, label: match.label, kind: match.kind } : null;
}

// ── Events ──────────────────────────────────────────────────────────────────

const EVENT_INPUT_LIMITS = { maxString: MAX_INPUT_STRING, maxDepth: MAX_INPUT_DEPTH, maxItems: 20 };

function truncateStrings(value, depth, limits = EVENT_INPUT_LIMITS) {
  if (typeof value === 'string') {
    return value.length > limits.maxString ? value.slice(0, limits.maxString) + '…' : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= limits.maxDepth) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxItems).map((v) => truncateStrings(v, depth + 1, limits));
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, truncateStrings(v, depth + 1, limits)]),
  );
}

/**
 * Turn a raw hook payload from a remote source into what the board receives, or
 * null when it isn't a hook event. The session id is namespaced by source so a
 * remote key can never address a session on this machine.
 */
export function transformEvent(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.session_id !== 'string' || !raw.session_id) return null;
  if (typeof raw.hook_event_name !== 'string' || !raw.hook_event_name) return null;
  const event = { ...raw };
  for (const field of DROPPED_FIELDS) delete event[field];
  const prUrl = prUrlOf(raw);
  if (prUrl) event.pr_url = prUrl;
  if (event.tool_input !== undefined) event.tool_input = truncateStrings(event.tool_input, 0);
  event.session_id = `${source.id}:${raw.session_id}`;
  event.pixel_source = { id: source.id, label: source.label, kind: source.kind };
  return event;
}

/**
 * The PR a successful `gh pr create` opened, read from the tool output before
 * that output is dropped, so remote PRs still become trophies on the board.
 */
function prUrlOf(raw) {
  if (raw.hook_event_name !== 'PostToolUse') return undefined;
  const command = raw.tool_input?.command;
  if (typeof command !== 'string' || !PR_CREATE.test(command)) return undefined;
  const text =
    typeof raw.tool_response === 'string' ? raw.tool_response : JSON.stringify(raw.tool_response);
  return text?.match(GITHUB_PR_URL)?.[0];
}

// ── Approvals ───────────────────────────────────────────────────────────────
//
// A sender's synchronous PermissionRequest hook posts here and waits. The relay
// long-polls the board (/api/permissions/wait, the board's own token) and turns
// its answer into the exact stdout Claude Code reads. It mirrors the local hook
// script (server/src/providers/hook/claude/hooks/claude-hook.ts and
// server/src/permissions/questions.ts): the output is rebuilt from validated
// fields only, never "always allow", never rewritten input -- except an
// AskUserQuestion's `answers`, built from the sender's ORIGINAL tool input.

/** What the board's long-poll receives for one remote PermissionRequest, or
 *  null when the payload isn't one. Session id namespaced like every event. */
export function permissionWaitBody(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.hook_event_name !== 'PermissionRequest') return null;
  if (typeof raw.session_id !== 'string' || !raw.session_id) return null;
  if (typeof raw.tool_name !== 'string' || !raw.tool_name) return null;
  const body = {
    requestId: crypto.randomUUID(),
    session_id: `${source.id}:${raw.session_id}`,
    tool_name: raw.tool_name,
    tool_input: truncateStrings(raw.tool_input ?? {}, 0, WAIT_INPUT_LIMITS),
    pixel_source: { id: source.id, label: source.label, kind: source.kind },
  };
  if (typeof raw.cwd === 'string') body.cwd = raw.cwd;
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_WAIT_BODY_BYTES) {
    body.tool_input = truncateStrings(raw.tool_input ?? {}, 0, EVENT_INPUT_LIMITS);
  }
  return body;
}

function rawQuestions(toolInput) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const { questions } = toolInput;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  if (questions.length > QUESTION_MAX_QUESTIONS) return null;
  for (const q of questions) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
    if (typeof q.question !== 'string' || !q.question) return null;
    if (!Array.isArray(q.options) || q.options.length > QUESTION_MAX_OPTIONS) return null;
    for (const o of q.options) {
      if (!o || typeof o !== 'object' || typeof o.label !== 'string' || !o.label) return null;
    }
  }
  return questions;
}

/** The `answers` map for an AskUserQuestion: question text -> chosen labels
 *  (and any "Other" text) joined with ", ". Null when the board's answers
 *  (option indices, free text) don't fit the original questions. */
export function answersForToolInput(toolInput, answers) {
  const questions = rawQuestions(toolInput);
  if (!questions || !Array.isArray(answers) || answers.length !== questions.length) return null;
  const map = {};
  for (let i = 0; i < questions.length; i++) {
    const answer = answers[i];
    if (!answer || typeof answer !== 'object' || !Array.isArray(answer.options)) return null;
    const picked = new Set();
    for (const n of answer.options) {
      if (!Number.isInteger(n) || n < 0 || n >= questions[i].options.length || picked.has(n)) {
        return null;
      }
      picked.add(n);
    }
    if (questions[i].multiSelect !== true && picked.size > 1) return null;
    if (answer.other !== undefined && typeof answer.other !== 'string') return null;
    const other = answer.other?.trim() ?? '';
    if (other.length > QUESTION_OTHER_MAX_CHARS) return null;
    if (picked.size === 0 && !other) return null;
    const parts = [...picked].sort((a, b) => a - b).map((n) => questions[i].options[n].label);
    if (other) parts.push(other);
    map[questions[i].question] = parts.join(', ');
  }
  return map;
}

/** JSON with every non-ASCII char escaped, so no shell or console code page
 *  on the sender can mangle it on the way to Claude Code. */
function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The sender hook's stdout for the board's answer, or null (print nothing:
 *  the sender's terminal decides). */
export function permissionHookOutput(response, toolName, toolInput) {
  if (!response || typeof response !== 'object') return null;
  const { decision } = response;
  if (!decision || typeof decision !== 'object') return null;
  const { behavior, message, answers } = decision;
  if (behavior !== 'allow' && behavior !== 'deny') return null;
  const out = { behavior };
  if (behavior === 'deny' && typeof message === 'string' && message.length > 0) {
    out.message = message.slice(0, 1000);
  }
  if (behavior === 'allow' && toolName === QUESTION_TOOL_NAME) {
    const map = answersForToolInput(toolInput, answers);
    if (!map) return null;
    out.updatedInput = { ...toolInput, answers: map };
  }
  return asciiJson({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: out } });
}

/** Long-poll the board for one request. The parsed answer, or null on any
 *  failure. `signal` aborts it (the sender went away). Never rejects. */
export function waitOnBoard(body, board, signal) {
  return new Promise((resolve) => {
    if (!board || signal?.aborted) return resolve(null);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: board.port,
        method: 'POST',
        path: BOARD_WAIT_PATH,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          authorization: `Bearer ${board.token}`,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > BOARD_RESPONSE_MAX_BYTES) {
            res.destroy();
            done(null);
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return done(null);
          try {
            done(JSON.parse(data));
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
      },
    );
    const onAbort = () => {
      req.destroy();
      done(null);
    };
    const deadline = setTimeout(onAbort, BOARD_WAIT_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort);
    req.on('error', () => done(null));
    req.end(text);
  });
}

// ── Usage ───────────────────────────────────────────────────────────────────
//
// Claude Code states the subscription's usage (`rate_limits`) only to a status
// line command. A sender's status line posts its stdin here; the relay forwards
// the two usage windows -- numbers only, nothing else of the input (no cwd,
// session or transcript) -- to the board's /api/usage, and answers with the
// line to print. Mirrors server/src/usage/rateLimits.ts and the local
// claude-statusline script; the board validates the report with its own parser.

function usageWindow(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const used = raw.used_percentage;
  const resets = raw.resets_at;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) return undefined;
  const resetsAt = Math.round(resets < 1e12 ? resets * 1000 : resets);
  if (resetsAt <= now) return undefined;
  return { usedPercentage: Math.min(100, Math.max(0, used)), resetsAt };
}

/** The usage windows in a status line's input, or undefined when it has none
 *  (an API-key user, a session before its first reply, junk). */
export function usageWindows(input, now = Date.now()) {
  const limits = input?.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return undefined;
  const fiveHour = usageWindow(limits.five_hour, now);
  const sevenDay = usageWindow(limits.seven_day, now);
  if (!fiveHour && !sevenDay) return undefined;
  return { fiveHour, sevenDay };
}

/** What the board's /api/usage receives: the windows in the status line's own
 *  shape, nothing else. */
export function usageReportBody(windows) {
  const raw = (w) => (w ? { used_percentage: w.usedPercentage, resets_at: w.resetsAt } : undefined);
  return { rate_limits: { five_hour: raw(windows.fiveHour), seven_day: raw(windows.sevenDay) } };
}

/** "Opus 5.5 | 5h 23% (resets 6:30 PM) | 7d 41%", ASCII only (any shell or
 *  console prints it as is); the model alone without usage. */
export function statusLineText(input, windows) {
  const parts = [];
  const model = input?.model?.display_name;
  if (typeof model === 'string' && model.trim()) {
    parts.push(
      model
        .replace(/[^\x20-\x7e]/g, '')
        .trim()
        .slice(0, MAX_MODEL_NAME_CHARS),
    );
  }
  if (windows?.fiveHour) {
    const resets = new Date(windows.fiveHour.resetsAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    parts.push(`5h ${Math.floor(windows.fiveHour.usedPercentage)}% (resets ${resets})`);
  }
  if (windows?.sevenDay) parts.push(`7d ${Math.floor(windows.sevenDay.usedPercentage)}%`);
  return parts
    .filter(Boolean)
    .join(' | ')
    .replace(/[^\x20-\x7e]/g, ' ');
}

function postUsage(body, { port, token }) {
  return new Promise((resolve) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: BOARD_USAGE_PATH,
        timeout: FORWARD_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve());
    req.end(text);
  });
}

/** Deliver one usage report to every server. Never rejects. */
export async function forwardUsage(body, servers) {
  await Promise.all(servers.map((s) => postUsage(body, s)));
}

// ── Forwarding ──────────────────────────────────────────────────────────────

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Live, well-formed entries of ~/.pixel-agents/servers/*.json. */
function liveServerEntries(home) {
  const dir = path.join(home, '.pixel-agents', 'servers');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (!Number.isInteger(entry.port) || !Number.isInteger(entry.pid)) continue;
      if (typeof entry.token !== 'string' || !entry.token) continue;
      if (isProcessAlive(entry.pid)) entries.push(entry);
    } catch {
      // malformed entry: skip
    }
  }
  return entries;
}

/** Live Pixel Agents servers from ~/.pixel-agents/servers/*.json. */
export function discoverServers(home = os.homedir()) {
  return liveServerEntries(home).map(({ port, token }) => ({ port, token }));
}

/** The server that answers approvals: the newest live standalone server (the
 *  board), else the newest live server -- the local hook script's rule. */
export function discoverBoard(home = os.homedir()) {
  const newestFirst = liveServerEntries(home).sort(
    (a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0),
  );
  const board = newestFirst.find((s) => s.standalone !== undefined) ?? newestFirst[0];
  return board ? { port: board.port, token: board.token } : undefined;
}

function postToServer(event, { port, token }) {
  return new Promise((resolve) => {
    const body = JSON.stringify(event);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/hooks/claude',
        timeout: FORWARD_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve());
    req.end(body);
  });
}

/** Deliver one event to every server. Never rejects. */
export async function forwardEvent(event, servers) {
  await Promise.all(servers.map((s) => postToServer(event, s)));
}

/** Serialize forwards so the board sees events in arrival order. */
function createForwardQueue(send) {
  let tail = Promise.resolve();
  let queued = 0;
  return (event) => {
    if (queued >= MAX_QUEUED_FORWARDS) return;
    queued++;
    tail = tail.then(() => send(event)).finally(() => queued--);
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function bearer(req) {
  const match = (req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : undefined;
}

/**
 * HTTP server with three routes, all POST and per-source authenticated:
 *  - /ingest: one hook event, answered 204 at once and forwarded to the board.
 *  - /ingest/permission (when `waitForDecision` is given): a PermissionRequest
 *    held open until the board answers. 200 with the hook's stdout, or 204
 *    (no answer: the sender's terminal decides). The sender going away aborts
 *    the board's wait, so the board stops offering the request.
 *  - /ingest/usage (when `forwardUsage` is given): a status line's input. 200
 *    with the line to print; its usage windows alone go on to the board.
 */
export function createRelayServer({
  getConfig,
  forward,
  waitForDecision,
  forwardUsage: sendUsage,
  maxBodyBytes = MAX_BODY_BYTES,
  maxWaits = MAX_PERMISSION_WAITS,
}) {
  let waits = 0;

  const handleUsage = (raw, res) => {
    const windows = usageWindows(raw);
    const line = `${statusLineText(raw, windows)}\n`;
    res
      .writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(line),
      })
      .end(line);
    if (!windows) return;
    try {
      Promise.resolve(sendUsage(usageReportBody(windows))).catch(() => {});
    } catch {
      // the board being down is not the sender's problem
    }
  };

  const handlePermission = (raw, source, res, reply) => {
    const body = permissionWaitBody(raw, source);
    if (!body) return reply(400);
    if (waits >= maxWaits) return reply(204);
    waits++;
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    Promise.resolve()
      .then(() => waitForDecision(body, controller.signal))
      .catch(() => null)
      .then((response) => {
        waits--;
        const output = response
          ? permissionHookOutput(response, raw.tool_name, raw.tool_input)
          : null;
        if (res.writableEnded || res.destroyed) return;
        if (!output) return reply(204);
        res
          .writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(output),
          })
          .end(output);
      });
  };

  const server = http.createServer((req, res) => {
    const reply = (status) => {
      if (!res.headersSent) res.writeHead(status).end();
    };
    const pathname = (req.url ?? '').split('?')[0];
    const route = INGEST_PATHS.has(pathname)
      ? 'ingest'
      : PERMISSION_PATHS.has(pathname) && waitForDecision
        ? 'permission'
        : USAGE_PATHS.has(pathname) && sendUsage
          ? 'usage'
          : null;
    if (req.method !== 'POST' || !route) {
      req.resume();
      return reply(404);
    }
    const source = findSource(getConfig(), bearer(req));
    if (!source) {
      req.resume();
      return reply(401);
    }

    const chunks = [];
    let size = 0;
    let tooLarge = Number(req.headers['content-length']) > maxBodyBytes;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('error', () => reply(400));
    req.on('end', () => {
      if (tooLarge) return reply(413);
      let raw;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return reply(400);
      }
      if (route === 'permission') return handlePermission(raw, source, res, reply);
      if (route === 'usage') return handleUsage(raw, res);
      const event = transformEvent(raw, source);
      if (!event) return reply(400);
      reply(204);
      try {
        Promise.resolve(forward(event)).catch(() => {});
      } catch {
        // the board being down is not the sender's problem
      }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

// ── Senders ─────────────────────────────────────────────────────────────────

/** The events Pixel Agents installs locally (server/src/providers/hook/claude/constants.ts). */
export const SENDER_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
];

/**
 * A Windows PowerShell 5.1 / PowerShell 7 one-liner with the same job as the
 * computer curl command. It reads stdin as UTF-8 bytes itself ([Console]::In
 * decodes with the console code page and mangles non-ASCII) and posts bytes
 * (5.1's Invoke-RestMethod mangles non-ASCII string bodies). TLS 1.2 is added
 * for older 5.1 setups. No double quotes, so it survives any argv quoting.
 */
function powershellPost(url) {
  return (
    "try { $ErrorActionPreference = 'Stop'; " +
    '[Net.ServicePointManager]::SecurityProtocol = ' +
    '[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; ' +
    '$b = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8).ReadToEnd(); ' +
    "$k = [IO.File]::ReadAllText($env:USERPROFILE + '\\.pixel-agents\\ingest-key').Trim(); " +
    `Invoke-RestMethod -Uri '${url}' -Method Post -UseBasicParsing -TimeoutSec 5 ` +
    "-ContentType 'application/json' -Headers @{ Authorization = 'Bearer ' + $k } " +
    '-Body ([Text.Encoding]::UTF8.GetBytes($b)) | Out-Null } catch {}; exit 0'
  );
}

/**
 * The PowerShell twin of the bash approvals hook: post the PermissionRequest
 * to the relay's permission route, print a 200's body (the relay escapes it to
 * ASCII, so the console code page can't mangle it), print nothing otherwise.
 */
function powershellWait(url) {
  return (
    "try { $ErrorActionPreference = 'Stop'; " +
    '[Net.ServicePointManager]::SecurityProtocol = ' +
    '[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; ' +
    '$b = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8).ReadToEnd(); ' +
    "$k = [IO.File]::ReadAllText($env:USERPROFILE + '\\.pixel-agents\\ingest-key').Trim(); " +
    `$r = Invoke-WebRequest -Uri '${url}' -Method Post -UseBasicParsing ` +
    `-TimeoutSec ${SENDER_WAIT_CURL_SECONDS} ` +
    "-ContentType 'application/json' -Headers @{ Authorization = 'Bearer ' + $k } " +
    '-Body ([Text.Encoding]::UTF8.GetBytes($b)); ' +
    'if ($r.StatusCode -eq 200) { $c = $r.Content; ' +
    'if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }; ' +
    '[Console]::Out.Write($c) } } catch {}; exit 0'
  );
}

/** The relay's permission route under an ingest URL (…/ingest → …/ingest/permission). */
function permissionUrl(url) {
  return `${url.replace(/\/+$/, '')}/permission`;
}

/** Throws unless `url` is a plain https URL, safe to quote in a command. */
function assertIngestUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'https:' || /['"\s\\`$]/.test(url)) {
    throw new Error('the ingest URL must be a plain https:// URL');
  }
}

/**
 * The settings.json `statusLine` that feeds the board's usage meter from this
 * computer: post the status line's input to the relay's usage route and print
 * the line it answers with ("Opus 5.5 | 5h 23% (resets 6:30 PM) | 7d 41%").
 * Offline it prints nothing (an empty status line). It REPLACES any status
 * line the computer has, so sender-config prints it separately.
 */
export function senderStatusLine({ url, shell = 'bash' }) {
  if (shell !== 'bash' && shell !== 'powershell') {
    throw new Error(`invalid shell "${shell}" (bash or powershell)`);
  }
  assertIngestUrl(url);
  const usageUrl = `${url.replace(/\/+$/, '')}/usage`;
  if (shell === 'powershell') {
    const command =
      "try { $ErrorActionPreference = 'Stop'; " +
      '[Net.ServicePointManager]::SecurityProtocol = ' +
      '[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; ' +
      '$b = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8).ReadToEnd(); ' +
      "$k = [IO.File]::ReadAllText($env:USERPROFILE + '\\.pixel-agents\\ingest-key').Trim(); " +
      `$r = Invoke-WebRequest -Uri '${usageUrl}' -Method Post -UseBasicParsing ` +
      `-TimeoutSec ${SENDER_USAGE_CURL_SECONDS} ` +
      "-ContentType 'application/json' -Headers @{ Authorization = 'Bearer ' + $k } " +
      '-Body ([Text.Encoding]::UTF8.GetBytes($b)); ' +
      'if ($r.StatusCode -eq 200) { $c = $r.Content; ' +
      'if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }; ' +
      '[Console]::Out.Write($c) } } catch {}; exit 0';
    return { type: 'command', shell, command, padding: 0 };
  }
  const command =
    `curl -sf -m ${SENDER_USAGE_CURL_SECONDS} -X POST -H 'Content-Type: application/json'` +
    ` -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)"` +
    ` --data-binary @- '${usageUrl}' 2>/dev/null; exit 0`;
  return { type: 'command', command, padding: 0 };
}

/**
 * The settings.json `hooks` block that sends a machine's events to the relay.
 * Every event hook is async, so a session never waits on the network. With
 * `approvals` (the default), PermissionRequest gets a second, synchronous hook
 * that waits on the board through the relay and prints its answer: the
 * terminal dialog is up meanwhile, and whichever answers first wins. Every
 * failure prints nothing, so the terminal decides, as without Pixel Agents.
 * - computer: user-level settings; the key is read from ~/.pixel-agents/ingest-key.
 *   shell 'powershell' is for Windows without Git Bash; the key is read from
 *   %USERPROFILE%\.pixel-agents\ingest-key.
 * - cloud: committed to a repo's .claude/settings.json; exits at once unless
 *   CLAUDE_CODE_REMOTE=true, and carries no key -- the cloud environment's
 *   network secret adds the Authorization header on the way out. Bash only.
 */
export function senderHooks({ url, cloud, shell = 'bash', approvals = true }) {
  if (shell !== 'bash' && shell !== 'powershell') {
    throw new Error(`invalid shell "${shell}" (bash or powershell)`);
  }
  if (cloud && shell === 'powershell') {
    throw new Error('cloud senders run on Linux: use bash');
  }
  assertIngestUrl(url);
  const waitUrl = permissionUrl(url);
  let hook;
  let waitHook;
  if (shell === 'powershell') {
    hook = { type: 'command', shell, command: powershellPost(url), async: true, timeout: 10 };
    waitHook = {
      type: 'command',
      shell,
      command: powershellWait(waitUrl),
      timeout: SENDER_WAIT_HOOK_TIMEOUT_SECONDS,
    };
  } else {
    const auth = cloud ? '' : ` -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)"`;
    const onlyInCloud = cloud ? `[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0; ` : '';
    const post =
      `curl -s -m 5 -X POST -H 'Content-Type: application/json'${auth}` +
      ` --data-binary @- '${url}' >/dev/null 2>&1`;
    hook = { type: 'command', command: `${onlyInCloud}${post}; exit 0`, async: true, timeout: 10 };
    // -f: an HTTP error prints nothing. A 204 has no body. Only a 200 -- the
    // board's answer as the relay built it -- reaches stdout.
    const wait =
      `curl -sf -m ${SENDER_WAIT_CURL_SECONDS} -X POST -H 'Content-Type: application/json'${auth}` +
      ` --data-binary @- '${waitUrl}' 2>/dev/null`;
    waitHook = {
      type: 'command',
      command: `${onlyInCloud}${wait}; exit 0`,
      timeout: SENDER_WAIT_HOOK_TIMEOUT_SECONDS,
    };
  }
  const hooks = Object.fromEntries(
    SENDER_EVENTS.map((event) => [event, [{ matcher: '', hooks: [{ ...hook }] }]]),
  );
  if (approvals) hooks.PermissionRequest.push({ matcher: '', hooks: [waitHook] });
  return hooks;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** loadConfig, re-read only when relay.json changes, so revoking a key needs no restart. */
function watchedConfig(home) {
  let cached;
  let mtime = -1;
  return () => {
    let current = 0;
    try {
      current = fs.statSync(configPath(home)).mtimeMs;
    } catch {
      // missing file: no sources
    }
    if (current !== mtime) {
      cached = loadConfig(home);
      mtime = current;
    }
    return cached;
  };
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv) {
  const [command, ...args] = argv;
  const home = os.homedir();
  switch (command) {
    case 'serve': {
      const getConfig = watchedConfig(home);
      const port = Number(flag(args, 'port') ?? getConfig().port);
      const forward = createForwardQueue((event) => forwardEvent(event, discoverServers(home)));
      const waitForDecision = (body, signal) => waitOnBoard(body, discoverBoard(home), signal);
      const sendUsage = (body) => forwardUsage(body, discoverServers(home));
      const server = createRelayServer({
        getConfig,
        forward,
        waitForDecision,
        forwardUsage: sendUsage,
      });
      server.listen(port, '127.0.0.1', () => {
        console.log(`[relay] listening on http://127.0.0.1:${port}/ingest`);
        console.log(
          `[relay] sources: ${
            getConfig()
              .sources.map((s) => s.id)
              .join(', ') || 'none'
          }`,
        );
      });
      return;
    }
    case 'add-source': {
      const [id] = args;
      const key = addSource(home, {
        id,
        label: flag(args, 'label') ?? id,
        kind: flag(args, 'kind'),
      });
      console.log(`Source "${id}" ready. Its key (shown once):\n\n${key}\n`);
      return;
    }
    case 'remove-source': {
      const removed = removeSource(home, args[0]);
      console.log(removed ? `Removed "${args[0]}".` : `No source "${args[0]}".`);
      process.exitCode = removed ? 0 : 1;
      return;
    }
    case 'list': {
      for (const s of loadConfig(home).sources) console.log(`${s.id}\t${s.kind}\t${s.label}`);
      return;
    }
    case 'sender-config': {
      const cloud = args.includes('--cloud');
      const hooks = senderHooks({
        url: flag(args, 'url'),
        cloud,
        shell: flag(args, 'shell'),
        approvals: !args.includes('--no-approvals'),
      });
      // The usage meter's status line: computers only (a cloud session's
      // usage is the same account's), and it replaces any status line there.
      const config =
        cloud || args.includes('--no-usage')
          ? { hooks }
          : {
              hooks,
              statusLine: senderStatusLine({ url: flag(args, 'url'), shell: flag(args, 'shell') }),
            };
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    default:
      console.log(
        'Usage: relay.mjs serve [--port N]\n' +
          '       relay.mjs add-source <id> --kind computer|cloud [--label L]\n' +
          '       relay.mjs remove-source <id>\n' +
          '       relay.mjs list\n' +
          '       relay.mjs sender-config --url https://<host>/ingest [--cloud] [--shell powershell] [--no-approvals] [--no-usage]',
      );
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[relay] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
