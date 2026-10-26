import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../core/src/isRecord.js';
import type { AgentLook, Directory, DirectoryConversations } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CONVERSATION_LOOKS_MAX,
  CONVERSATIONS_FILE_NAME,
  CONVERSATIONS_PER_DIRECTORY,
  NEW_CONVERSATION_TITLE,
  PIXEL_AGENTS_DIR,
} from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';

/**
 * The sidebar's recent conversations: each Directory's newest transcripts,
 * titled the way the coding agent titles them, with the character their agent
 * wore so a resume brings that character back to its seat.
 *
 * The transcripts are the coding agent's (found through the provider); what
 * this module adds is the look, which only the office knows. It is recorded
 * per session in ~/.pixel-agents/conversations.json whenever the office saves
 * its seats — an agent's seat is only known to the office — so it outlives the
 * agent, and the newest CONVERSATION_LOOKS_MAX are kept.
 */

export type ConversationLook = Omit<AgentLook, 'id'> & {
  seatId?: string;
  /** When it was last recorded (ms), for pruning. */
  at: number;
};

type Looks = Record<string, ConversationLook>;

function looksPath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, CONVERSATIONS_FILE_NAME);
}

function readLooks(): Looks {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(looksPath(), 'utf-8'));
    if (!isRecord(raw)) return {};
    const looks: Looks = {};
    for (const [sessionId, look] of Object.entries(raw)) {
      const l = look as Partial<ConversationLook> | null;
      if (!l || !Number.isInteger(l.palette) || !Number.isInteger(l.repeat)) continue;
      looks[sessionId] = {
        palette: l.palette!,
        repeat: l.repeat!,
        seatId: typeof l.seatId === 'string' ? l.seatId : undefined,
        at: typeof l.at === 'number' ? l.at : 0,
      };
    }
    return looks;
  } catch {
    return {};
  }
}

/**
 * Renumber the remembered looks after the character list changed (see characterRemap.ts):
 * a look whose character was deleted is forgotten.
 */
export function remapConversationLooks(remap: (palette: number) => number | undefined): void {
  const looks = readLooks();
  let changed = false;
  for (const [sessionId, look] of Object.entries(looks)) {
    const next = remap(look.palette);
    if (next === look.palette) continue;
    changed = true;
    if (next === undefined) delete looks[sessionId];
    else look.palette = next;
  }
  if (!changed) return;
  try {
    writeJsonAtomic(looksPath(), looks);
  } catch (err) {
    console.error('[Pixel Agents] Failed to save conversation looks:', err);
  }
}

/** The look a session's agent last had, if the office ever saw it. */
export function conversationLook(sessionId: string): ConversationLook | undefined {
  return readLooks()[sessionId];
}

/**
 * Remember what the agents in `seats` (a saveAgentSeats payload, keyed by
 * agent id) wear and where they sit, under their session ids. Writes only
 * when something changed: the office saves its seats often.
 */
export function recordConversationLooks(
  store: AgentStateStore,
  seats: Record<string, { seatId?: string }>,
): void {
  const looks = readLooks();
  let changed = false;
  const now = Date.now();
  for (const [idStr, meta] of Object.entries(seats)) {
    const agent = store.get(Number(idStr));
    if (!agent?.sessionId || agent.palette === undefined) continue;
    const before = looks[agent.sessionId];
    const look: ConversationLook = {
      palette: agent.palette,
      repeat: agent.repeat ?? 0,
      seatId: typeof meta.seatId === 'string' ? meta.seatId : before?.seatId,
      at: now,
    };
    if (
      before &&
      before.palette === look.palette &&
      before.repeat === look.repeat &&
      before.seatId === look.seatId
    ) {
      continue;
    }
    looks[agent.sessionId] = look;
    changed = true;
  }
  if (!changed) return;
  const kept = Object.entries(looks)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, CONVERSATION_LOOKS_MAX);
  try {
    writeJsonAtomic(looksPath(), Object.fromEntries(kept));
  } catch (err) {
    console.error('[Pixel Agents] Failed to save conversation looks:', err);
  }
}

/** Where a Directory's sessions are filed (the provider knows the CLI's rule,
 *  e.g. a Directory reached through a symlink filed under the resolved path). */
function sessionDirsFor(provider: HookProvider, directoryPath: string): string[] {
  return provider.getSessionDirs?.(directoryPath) ?? [];
}

/** A session's transcript in the Directory at `directoryPath`, if it exists. */
export function findTranscript(
  provider: HookProvider,
  directoryPath: string,
  sessionId: string,
): string | undefined {
  return sessionDirsFor(provider, directoryPath)
    .map((dir) => path.join(dir, `${sessionId}.jsonl`))
    .find((file) => fs.existsSync(file));
}

/** An agent in the office, as the list needs it: which one runs a session
 *  and what it wears. */
export interface LiveSession {
  agentId: number;
  palette?: number;
  repeat?: number;
}

/** Which agent in the office runs each session (keyed by session id). */
export function liveSessions(store: AgentStateStore): Map<string, LiveSession> {
  // Background-spawn children share their lead's session: the lead runs it.
  return new Map(
    [...store]
      .filter(([, agent]) => !agent.spawnToolUseId)
      .map(([id, agent]) => [
        agent.sessionId,
        { agentId: id, palette: agent.palette, repeat: agent.repeat },
      ]),
  );
}

/** A resumable session id: a UUID, never anything a CLI could read as a flag. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What resuming a conversation needs, checked. */
export interface ResumeRequest {
  sessionId: string;
  directoryPath: string;
  transcript: string;
  /** The look its agent last had, if the office ever saw it. */
  look: ConversationLook | undefined;
}

/**
 * A `resumeConversation` request, or null when there is nothing to resume:
 * the id isn't a UUID (it becomes a CLI argument), the Directory isn't a
 * string, an agent in the office already runs the session, or its transcript
 * doesn't exist.
 */
export function resumeRequest(
  store: AgentStateStore,
  provider: HookProvider,
  msg: { sessionId?: unknown; directoryPath?: unknown },
): ResumeRequest | null {
  const { sessionId, directoryPath } = msg;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
  if (typeof directoryPath !== 'string') return null;
  // Already in the office: nothing to bring back.
  if ([...store].some(([, agent]) => agent.sessionId === sessionId)) return null;
  const transcript = findTranscript(provider, directoryPath, sessionId);
  if (!transcript) return null;
  return { sessionId, directoryPath, transcript, look: conversationLook(sessionId) };
}

/** A transcript as the listing sees it. */
interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Titles already read, by transcript path, with the size and mtime they were
 * read at. A title is a function of the file, so an entry is used only while
 * both still match (any write changes them). Untitled results are kept too, or
 * every untitled session would be re-read on each listing. Entries a listing
 * didn't look at are dropped after it.
 */
const titleCache = new Map<string, { size: number; mtimeMs: number; title: string | undefined }>();

function cachedTitle(
  provider: HookProvider,
  file: TranscriptFile,
  seen: Set<string>,
): string | undefined {
  seen.add(file.path);
  const hit = titleCache.get(file.path);
  if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.title;
  const title = provider.conversationTitle?.(file.path);
  titleCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, title });
  return title;
}

/**
 * Each Directory's conversations, newest first: the ones an agent in the
 * office is running (with its id and what it wears now; titled "New
 * conversation" until the coding agent titles it) and its newest past ones,
 * interleaved by when they were last written. Only the past ones are capped,
 * at CONVERSATIONS_PER_DIRECTORY, and a past one without a title (a session
 * that never got a prompt) is left out.
 */
export function listConversations(
  directories: readonly Directory[],
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
): DirectoryConversations[] {
  const looks = readLooks();
  const seen = new Set<string>();
  const listed = directories.map((directory) => {
    const conversations: DirectoryConversations['conversations'] = [];
    let past = 0;
    const files = sessionDirsFor(provider, directory.path)
      .flatMap(transcriptsIn)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files) {
      const sessionId = path.basename(file.path, '.jsonl');
      const running = live.get(sessionId);
      if (!running && past >= CONVERSATIONS_PER_DIRECTORY) continue;
      const title = cachedTitle(provider, file, seen) ?? (running && NEW_CONVERSATION_TITLE);
      if (!title) continue;
      const look = running ?? looks[sessionId];
      conversations.push({
        sessionId,
        title,
        updatedAt: file.mtimeMs,
        palette: look?.palette,
        repeat: look?.repeat,
        agentId: running?.agentId,
      });
      if (!running) past++;
    }
    return { name: directory.name, path: directory.path, conversations };
  });
  for (const cached of titleCache.keys()) if (!seen.has(cached)) titleCache.delete(cached);
  return listed;
}

/** A project dir's transcripts. */
function transcriptsIn(projectDir: string): TranscriptFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(projectDir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return files;
}
