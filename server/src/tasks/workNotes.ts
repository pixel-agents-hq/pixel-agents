/**
 * Work notes: what a task actually did, in the words that were used doing it --
 * the Manager's report is written from these, not just from counts.
 *
 *  - asks:     what the user typed (a local session's transcript only: the
 *              UserPromptSubmit hook is deliberately not installed)
 *  - outcomes: how each turn ended -- the agent's last reply before the next
 *              prompt (transcript), or the Stop hook's `last_assistant_message`
 *  - todos:    the agent's own plan (TodoWrite items, TaskCreate subjects)
 *  - commits:  commit subjects -- `git log` over the day for a local repo, or
 *              the `-m` of a `git commit` a remote session ran
 *
 * Everything is clipped and capped, so a long day stays a prompt-sized input.
 * Notes stay on this machine except as input to the report run and, when it is
 * configured, the report that run writes (notionPublisher.ts).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WORK_NOTE_ASK_CHARS,
  WORK_NOTE_COMMIT_CHARS,
  WORK_NOTE_MAX_ASKS,
  WORK_NOTE_MAX_COMMITS,
  WORK_NOTE_MAX_OUTCOMES,
  WORK_NOTE_MAX_TODOS,
  WORK_NOTE_OUTCOME_CHARS,
  WORK_NOTE_TODO_CHARS,
  WORK_NOTES_GIT_TIMEOUT_MS,
  WORK_NOTES_TRANSCRIPT_MAX_BYTES,
} from '../constants.js';

export interface WorkNotes {
  asks: string[];
  outcomes: string[];
  todos: string[];
  commits: string[];
}

export type WorkNoteKind = 'outcome' | 'todo' | 'commit';

const CAPS: Record<keyof WorkNotes, { max: number; chars: number; keep: 'first' | 'last' }> = {
  asks: { max: WORK_NOTE_MAX_ASKS, chars: WORK_NOTE_ASK_CHARS, keep: 'first' },
  // The last replies say where the task ended up.
  outcomes: { max: WORK_NOTE_MAX_OUTCOMES, chars: WORK_NOTE_OUTCOME_CHARS, keep: 'last' },
  todos: { max: WORK_NOTE_MAX_TODOS, chars: WORK_NOTE_TODO_CHARS, keep: 'first' },
  commits: { max: WORK_NOTE_MAX_COMMITS, chars: WORK_NOTE_COMMIT_CHARS, keep: 'first' },
};

export function emptyNotes(): WorkNotes {
  return { asks: [], outcomes: [], todos: [], commits: [] };
}

export function hasNotes(notes: WorkNotes): boolean {
  return notes.asks.length + notes.outcomes.length + notes.todos.length + notes.commits.length > 0;
}

/** Whitespace collapsed, clipped with an ellipsis. */
export function clipNote(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1).trimEnd()}…` : flat;
}

/** Replies that say nothing about the work: Claude Code's own stock lines. */
const STOCK_REPLY =
  /^(?:no response requested\.?|you.ve hit your .*limit.*|api error(?: .*|:.*)?|prompt is too long|\(no content\))$/i;

/** Add one note in place: clipped, deduplicated, capped. */
export function addNote(notes: WorkNotes, field: keyof WorkNotes, text: string): boolean {
  const cap = CAPS[field];
  const note = clipNote(text, cap.chars);
  if (!note || (field === 'outcomes' && STOCK_REPLY.test(note))) return false;
  const list = notes[field];
  const existing = list.indexOf(note);
  if (existing !== -1) {
    // A repeated outcome moves to the end: it is the latest word again.
    if (cap.keep !== 'last' || existing === list.length - 1) return false;
    list.splice(existing, 1);
  }
  if (list.length >= cap.max) {
    if (cap.keep === 'first') return false;
    list.shift();
  }
  list.push(note);
  return true;
}

/** b's notes added after a's, into a copy. */
export function mergeNotes(a: WorkNotes, b: WorkNotes): WorkNotes {
  const out = emptyNotes();
  for (const field of Object.keys(CAPS) as Array<keyof WorkNotes>) {
    for (const note of [...a[field], ...b[field]]) addNote(out, field, note);
  }
  return out;
}

/** A stored notes object, or undefined when it isn't one. */
export function parseNotes(raw: unknown): WorkNotes | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const notes = emptyNotes();
  for (const field of Object.keys(CAPS) as Array<keyof WorkNotes>) {
    const list = (raw as Record<string, unknown>)[field];
    if (!Array.isArray(list)) continue;
    for (const item of list) if (typeof item === 'string') addNote(notes, field, item);
  }
  return hasNotes(notes) ? notes : undefined;
}

// ── From tool calls ──────────────────────────────────────────

/** The plan items a TodoWrite or TaskCreate call states. */
export function todosFromTool(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    return (input.todos as unknown[])
      .map((t) =>
        typeof t === 'object' && t !== null ? (t as { content?: unknown }).content : undefined,
      )
      .filter((c): c is string => typeof c === 'string');
  }
  if (toolName === 'TaskCreate' && typeof input.subject === 'string') return [input.subject];
  return [];
}

// The closing quote is optional: a relayed command arrives clipped.
const COMMIT_MESSAGE =
  /\bgit\s+(?:-C\s+\S+\s+)?commit\b[^\n]*?\s-[a-z]*m\s*(?:"((?:[^"\\]|\\.)*)"?|'([^']*)'?)/;
const HEREDOC = /^\$\(cat\s+<<-?\s*'?(\w+)'?\s*\n([\s\S]*?)(?:\n\s*\1\b|$)/;

/** The subject of the commit a shell command makes with -m, if any. */
export function commitMessageOf(command: string): string | undefined {
  const match = command.match(COMMIT_MESSAGE);
  if (!match) return undefined;
  let message = (match[1] ?? match[2] ?? '').replace(/\\"/g, '"');
  const heredoc = message.match(HEREDOC);
  if (heredoc) message = heredoc[2];
  const subject = message.split('\n').find((l) => l.trim());
  return subject?.trim() || undefined;
}

// ── From a transcript ────────────────────────────────────────

interface Block {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** A prompt the user typed, or undefined for the injected and the tool-made. */
function typedPrompt(text: string): string | undefined {
  const t = text.replace(SYSTEM_REMINDER, '').trim();
  if (!t) return undefined;
  // Slash commands, their output, hook output, caveats and interruptions.
  if (t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('Caveat:')) {
    return undefined;
  }
  return t;
}

/**
 * A transcript's notes for records stamped within [fromMs, toMs]. A lead's
 * sidechain records are its sub-agents' turns and are skipped.
 */
export function transcriptWorkNotes(
  lines: readonly string[],
  fromMs: number,
  toMs: number,
): WorkNotes {
  const notes = emptyNotes();
  let lastReply: string | undefined;
  const closeTurn = () => {
    if (lastReply) addNote(notes, 'outcomes', lastReply);
    lastReply = undefined;
  };
  for (const line of lines) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    if (record.isMeta === true || record.isSidechain === true) continue;
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
    const content = (record.message as { content?: unknown } | undefined)?.content;
    const blocks: Block[] =
      typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : Array.isArray(content)
          ? (content as Block[])
          : [];
    for (const block of blocks) {
      if (record.type === 'user') {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const prompt = typedPrompt(block.text);
        if (!prompt) continue;
        closeTurn();
        addNote(notes, 'asks', prompt);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lastReply = block.text;
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input =
          typeof block.input === 'object' && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {};
        for (const todo of todosFromTool(block.name, input)) addNote(notes, 'todos', todo);
      }
    }
  }
  closeTurn();
  return notes;
}

/** Where Claude Code keeps session transcripts. */
export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** The transcript for a session id, searched across every project dir. */
export function findSessionTranscript(
  sessionId: string,
  projectsRoot: string = defaultProjectsRoot(),
): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const file = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

const TIMESTAMP = /"timestamp":"([^"]+)"/;
const PROBE_BYTES = 256 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Records are appended in order, give or take: read this far past the window's end. */
const WINDOW_SLACK_MS = 5 * 60_000;

function lineTime(line: string): number | undefined {
  const match = line.match(TIMESTAMP);
  const t = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** The time of the first whole stamped line at or after `offset`. */
function timeAt(fd: number, offset: number): number | undefined {
  const buf = Buffer.alloc(PROBE_BYTES);
  const read = fs.readSync(fd, buf, 0, PROBE_BYTES, offset);
  const lines = buf.toString('utf8', 0, read).split('\n');
  // The first piece is a fragment unless it starts the file; the last may be cut off.
  for (const line of lines.slice(offset > 0 ? 1 : 0, -1)) {
    const t = lineTime(line);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * A transcript's lines stamped within [fromMs, toMs], or null when unreadable.
 * Transcripts run to tens of megabytes over days, so the window's start is
 * found by bisecting on the records' timestamps and only the window is read.
 * Lines over a few megabytes (a huge tool result) are skipped, and at most
 * WORK_NOTES_TRANSCRIPT_MAX_BYTES are kept.
 */
export function readTranscriptWindow(file: string, fromMs: number, toMs: number): string[] | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = fs.fstatSync(fd);
    let lo = 0;
    let hi = size;
    while (hi - lo > PROBE_BYTES) {
      const mid = Math.floor((lo + hi) / 2);
      const t = timeAt(fd, mid);
      if (t !== undefined && t < fromMs) lo = mid;
      else hi = mid;
    }
    const lines: string[] = [];
    let kept = 0;
    let carry = '';
    let first = lo > 0;
    const buf = Buffer.alloc(CHUNK_BYTES);
    for (let offset = lo; offset < size;) {
      const read = fs.readSync(fd, buf, 0, CHUNK_BYTES, offset);
      if (read <= 0) break;
      offset += read;
      const parts = (carry + buf.toString('utf8', 0, read)).split('\n');
      carry = parts.pop() ?? '';
      if (carry.length > CHUNK_BYTES) carry = ''; // one enormous line: skip it
      for (const line of parts) {
        if (first) {
          first = false; // a fragment of the line the start landed in
          continue;
        }
        const t = lineTime(line);
        if (t !== undefined && t > toMs + WINDOW_SLACK_MS) return lines;
        if (t === undefined || t < fromMs || t > toMs) continue;
        if (kept + line.length > WORK_NOTES_TRANSCRIPT_MAX_BYTES) return lines;
        kept += line.length;
        lines.push(line);
      }
    }
    const t = carry && !first ? lineTime(carry) : undefined;
    if (t !== undefined && t >= fromMs && t <= toMs) lines.push(carry);
    return lines;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The working directory a transcript's records name (the first one). */
export function transcriptCwd(lines: readonly string[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

// ── From git ─────────────────────────────────────────────────

/** Runs git and resolves with stdout (injectable for tests). */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: WORK_NOTES_GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/**
 * The main repo root a directory belongs to (a worktree's is its repo's, so it
 * is named like the repo), or undefined outside git.
 */
export async function gitRoot(cwd: string, git: GitRunner = runGit): Promise<string | undefined> {
  try {
    const common = (
      await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
    ).trim();
    if (common && path.basename(common) === '.git') return path.dirname(common);
    const top = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    return top || undefined;
  } catch {
    return undefined;
  }
}

/** One commit in a repo's day. */
export interface GitCommit {
  hash: string;
  subject: string;
  /** The local branch it was reached from (a commit on several gets one). */
  branch: string;
}

/** What this machine's git user did in a repo over a stretch of time. */
export interface GitActivity {
  /** Oldest first. */
  commits: GitCommit[];
  /** Distinct files the commits touched. */
  files: number;
  insertions: number;
  deletions: number;
}

const RECORD = '\x1e';

/**
 * The commits this machine's git user made in a repo between two instants on
 * any local branch -- hash, subject, branch -- and the lines and files they
 * changed. Empty when git isn't there or fails.
 */
export async function gitActivity(
  root: string,
  fromMs: number,
  toMs: number,
  git: GitRunner = runGit,
): Promise<GitActivity> {
  const activity: GitActivity = { commits: [], files: 0, insertions: 0, deletions: 0 };
  try {
    const email = (await git(['config', 'user.email'], root).catch(() => '')).trim();
    const out = await git(
      [
        'log',
        '--branches',
        '--source',
        '--no-merges',
        '--reverse',
        `--since=${new Date(fromMs).toISOString()}`,
        `--until=${new Date(toMs).toISOString()}`,
        ...(email ? [`--author=${email}`] : []),
        '--numstat',
        `--format=${RECORD}%h%x09%S%x09%s`,
      ],
      root,
    );
    const files = new Set<string>();
    const seen = new Set<string>();
    for (const record of out.split(RECORD)) {
      const [head, ...stats] = record.split('\n');
      const [hash, ref, ...subject] = head.split('\t');
      if (!hash?.trim() || seen.has(hash) || activity.commits.length >= WORK_NOTE_MAX_COMMITS) {
        continue;
      }
      seen.add(hash);
      activity.commits.push({
        hash: hash.trim(),
        subject: clipNote(subject.join('\t'), WORK_NOTE_COMMIT_CHARS),
        branch: (ref ?? '').replace(/^refs\/(heads|remotes)\//, '') || 'unknown',
      });
      for (const line of stats) {
        const [added, removed, file] = line.split('\t');
        if (!file) continue;
        // Binary files show "-": they changed, but count no lines.
        if (/^\d+$/.test(added)) activity.insertions += Number(added);
        if (/^\d+$/.test(removed)) activity.deletions += Number(removed);
        files.add(file);
      }
    }
    activity.files = files.size;
  } catch {
    /* no git, or not a repo: nothing to add */
  }
  return activity;
}

/** The git branch a transcript's records last name (Claude Code stamps `gitBranch`). */
export function transcriptBranch(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/"gitBranch":"([^"]+)"/);
    if (match && match[1] !== 'HEAD') return match[1];
  }
  return undefined;
}
