/**
 * Claude Code `statusLine` command (bundled to dist/hooks/nakama-statusline.js).
 *
 * Reads the status JSON on stdin, prints the session bar, and leaves snapshots
 * under ~/.pixel-agents/statusline/ for Nakama. The line always prints: a
 * snapshot that cannot be written is skipped silently, because a status line
 * that errors shows nothing at all.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_JSON_DIR } from '../../../../constants.js';
import {
  STATUSLINE_DIR,
  STATUSLINE_FALLBACK_NAME,
  STATUSLINE_PRUNE_AGE_MS,
  STATUSLINE_PRUNE_CHANCE,
  STATUSLINE_RENAME_ATTEMPTS,
  STATUSLINE_RENAME_RETRY_MS,
  STATUSLINE_SESSIONS_DIR,
  STATUSLINE_SHAPE_FILE,
  STATUSLINE_STDIN_TIMEOUT_MS,
  STATUSLINE_TMP_MAX_AGE_MS,
  STATUSLINE_USAGE_FILE,
} from '../constants.js';
import type { UsageSnapshot } from './statusLine.js';
import {
  describeShape,
  formatStatusLine,
  mergeUsage,
  parseStatusInput,
  toSessionSnapshot,
  toUsageSnapshot,
} from './statusLine.js';

const ROOT = path.join(os.homedir(), SERVER_JSON_DIR, STATUSLINE_DIR);
const SESSIONS = path.join(ROOT, STATUSLINE_SESSIONS_DIR);
const USAGE = path.join(ROOT, STATUSLINE_USAGE_FILE);
/** Snapshots name the user's projects and sessions: owner-only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TMP_SUFFIX = '.tmp';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows refuses a rename onto a file someone holds open; retry briefly. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= STATUSLINE_RENAME_ATTEMPTS || !RETRYABLE_RENAME.has(code)) throw e;
      sleepSync(STATUSLINE_RENAME_RETRY_MS);
    }
  }
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}${TMP_SUFFIX}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: FILE_MODE });
    renameWithRetry(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing left to do */
    }
  }
}

function readUsage(): UsageSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(USAGE, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as UsageSnapshot) : null;
  } catch {
    return null;
  }
}

/** Old session snapshots, and tmp files left by a run killed mid-write. */
function prune(now: number): void {
  for (const dir of [ROOT, SESSIONS]) {
    for (const name of fs.readdirSync(dir)) {
      const isTmp = name.endsWith(TMP_SUFFIX);
      if (dir === ROOT && !isTmp) continue;
      const maxAge = isTmp ? STATUSLINE_TMP_MAX_AGE_MS : STATUSLINE_PRUNE_AGE_MS;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAge) fs.rmSync(file);
      } catch {
        /* another run got there first */
      }
    }
  }
}

function persist(parsed: unknown, now: number): void {
  const input = parseStatusInput(parsed);
  if (!input) return;
  fs.mkdirSync(SESSIONS, { recursive: true, mode: DIR_MODE });
  const session = toSessionSnapshot(input, now);
  if (session) writeAtomic(path.join(SESSIONS, `${session.sessionId}.json`), session);
  const usage = toUsageSnapshot(input, now);
  if (usage) writeAtomic(USAGE, mergeUsage(readUsage(), usage));
  writeAtomic(path.join(ROOT, STATUSLINE_SHAPE_FILE), describeShape(parsed));
  if (Math.random() < STATUSLINE_PRUNE_CHANCE) prune(now);
}

let printed = false;
let done = false;

/** Print once, then exit only after stdout has drained (a pipe may be async). */
function printAndExit(line: string): void {
  if (!printed) {
    printed = true;
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('', () => process.exit(0));
}

function run(raw: string): void {
  const now = Date.now();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* fall through with null: the bar still prints */
  }
  let line = STATUSLINE_FALLBACK_NAME;
  try {
    line = formatStatusLine(parseStatusInput(parsed) ?? {}, now, { color: true });
  } catch {
    /* keep the fallback */
  }
  if (!printed) {
    printed = true;
    process.stdout.write(`${line}\n`);
  }
  try {
    persist(parsed, now);
  } catch {
    /* never let the snapshot break the line */
  }
  printAndExit(line);
}

let raw = '';
function finish(): void {
  if (done) return;
  done = true;
  run(raw);
}

process.on('uncaughtException', () => printAndExit(STATUSLINE_FALLBACK_NAME));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  raw += chunk;
});
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, STATUSLINE_STDIN_TIMEOUT_MS).unref();
