import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../core/src/isRecord.js';
import type {
  AgentLook,
  Conversation,
  Directory,
  DirectoryConversations,
  FoundConversation,
} from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CONVERSATION_LOOKS_MAX,
  CONVERSATION_QUERY_MAX_CHARS,
  CONVERSATIONS_FILE_NAME,
  CONVERSATIONS_LIMIT_ENTRIES_MAX,
  CONVERSATIONS_LIMIT_MAX,
  CONVERSATIONS_PER_DIRECTORY,
  NEW_CONVERSATION_TITLE,
  PIXEL_AGENTS_DIR,
} from './constants.js';
import { transcriptSuffix } from './directorySuggestions.js';
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

/** A session's transcript in the Directory at `directoryPath`, if it exists.
 *  The provider's `sessionFilePattern` names transcripts: `*` is the session id. */
export function findTranscript(
  provider: HookProvider,
  directoryPath: string,
  sessionId: string,
): string | undefined {
  const suffix = transcriptSuffix(provider.sessionFilePattern);
  return sessionDirsFor(provider, directoryPath)
    .map((dir) => path.join(dir, `${sessionId}${suffix}`))
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
 * the provider lists no conversations (only one that names them is asked to
 * resume one, see HookProvider.buildLaunchCommand), the id isn't a UUID (it
 * becomes a CLI argument), the Directory isn't a string, an agent in the
 * office already runs the session, or its transcript doesn't exist.
 */
export function resumeRequest(
  store: AgentStateStore,
  provider: HookProvider,
  msg: { sessionId?: unknown; directoryPath?: unknown },
): ResumeRequest | null {
  if (!provider.conversationTitle || !provider.buildLaunchCommand) return null;
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
 * every untitled session would be re-read on each listing. A listing drops
 * the entries of transcripts it no longer finds (a search shares them).
 */
const titleCache = new Map<string, { size: number; mtimeMs: number; title: string | undefined }>();

function cachedTitle(provider: HookProvider, file: TranscriptFile): string | undefined {
  const hit = titleCache.get(file.path);
  if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.title;
  const title = provider.conversationTitle?.(file.path);
  titleCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, title });
  return title;
}

/** Every transcript of a Directory, newest first. */
function directoryTranscripts(directory: Directory, provider: HookProvider): TranscriptFile[] {
  const suffix = transcriptSuffix(provider.sessionFilePattern);
  return sessionDirsFor(provider, directory.path)
    .flatMap((dir) => transcriptsIn(dir, suffix))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A transcript as a listed conversation, or null when it has no title (a
 *  past session that never got a prompt; a running one is "New conversation"). */
function conversationOf(
  file: TranscriptFile,
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
  looks: Looks,
): Conversation | null {
  const sessionId = path.basename(file.path, transcriptSuffix(provider.sessionFilePattern));
  const running = live.get(sessionId);
  const title = cachedTitle(provider, file) ?? (running && NEW_CONVERSATION_TITLE);
  if (!title) return null;
  const look = running ?? looks[sessionId];
  return {
    sessionId,
    title,
    updatedAt: file.mtimeMs,
    palette: look?.palette,
    repeat: look?.repeat,
    agentId: running?.agentId,
  };
}

/** How many past conversations a Directory lists: its `limits` entry, within
 *  bounds, else CONVERSATIONS_PER_DIRECTORY. */
export function conversationLimitsFrom(limits: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(limits)) return out;
  for (const entry of limits.slice(0, CONVERSATIONS_LIMIT_ENTRIES_MAX)) {
    if (!isRecord(entry) || typeof entry.directoryPath !== 'string') continue;
    const count = entry.count;
    if (typeof count !== 'number' || !Number.isInteger(count)) continue;
    out.set(entry.directoryPath, clampLimit(count));
  }
  return out;
}

function clampLimit(count: number): number {
  return Math.min(Math.max(count, 1), CONVERSATIONS_LIMIT_MAX);
}

/**
 * Each Directory's newest conversations: the ones an agent in the office is
 * running (with its id and what it wears now; titled "New conversation" until
 * the coding agent titles it) and past ones, by when they were last written,
 * at most the Directory's `limits` entry (else CONVERSATIONS_PER_DIRECTORY)
 * of them all told; `more` says older ones exist. A past one without a title
 * (a session that never got a prompt) is left out.
 */
export function listConversations(
  directories: readonly Directory[],
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
  limits: ReadonlyMap<string, number> = new Map(),
): DirectoryConversations[] {
  const looks = readLooks();
  const found = new Set<string>();
  const listed = directories.map((directory): DirectoryConversations => {
    const limit = limits.get(directory.path) ?? CONVERSATIONS_PER_DIRECTORY;
    const conversations: Conversation[] = [];
    let more = false;
    for (const file of directoryTranscripts(directory, provider)) {
      found.add(file.path);
      // Past the cap, titles are read only until one says there are more.
      if (conversations.length >= limit) {
        if (!more) more = conversationOf(file, provider, live, looks) !== null;
        continue;
      }
      const conversation = conversationOf(file, provider, live, looks);
      if (conversation) conversations.push(conversation);
    }
    return {
      name: directory.name,
      path: directory.path,
      conversations,
      ...(more ? { more } : {}),
    };
  });
  for (const cached of titleCache.keys()) if (!found.has(cached)) titleCache.delete(cached);
  return listed;
}

/** What a search asks for. */
export interface ConversationQuery {
  query: string;
  /** Only this Directory's (else every Directory's). */
  directoryPath?: string;
  limit: number;
}

/** A `searchConversations` request, checked; null when malformed. */
export function conversationQueryFrom(msg: {
  query?: unknown;
  directoryPath?: unknown;
  limit?: unknown;
}): ConversationQuery | null {
  if (typeof msg.query !== 'string' || typeof msg.limit !== 'number') return null;
  if (!Number.isInteger(msg.limit)) return null;
  if (msg.directoryPath !== undefined && typeof msg.directoryPath !== 'string') return null;
  return {
    query: msg.query.slice(0, CONVERSATION_QUERY_MAX_CHARS),
    ...(msg.directoryPath !== undefined ? { directoryPath: msg.directoryPath } : {}),
    limit: clampLimit(msg.limit),
  };
}

/** Whether `title` holds every word of `query` (any case). */
export function titleMatches(title: string, query: string): boolean {
  const lower = title.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => lower.includes(word));
}

/**
 * The conversations whose title matches `query` (titleMatches), across every
 * Directory or the one asked for, newest first, at most `limit`; `more`: at
 * least one more matches. A session listed under two Directories counts once.
 */
export function searchConversations(
  directories: readonly Directory[],
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
  { query, directoryPath, limit }: ConversationQuery,
): { results: FoundConversation[]; more: boolean } {
  const looks = readLooks();
  const files = directories
    .filter((d) => directoryPath === undefined || d.path === directoryPath)
    .flatMap((directory) =>
      directoryTranscripts(directory, provider).map((file) => ({ file, directory })),
    )
    .sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
  const results: FoundConversation[] = [];
  const sessions = new Set<string>();
  for (const { file, directory } of files) {
    const conversation = conversationOf(file, provider, live, looks);
    if (!conversation || sessions.has(conversation.sessionId)) continue;
    if (!titleMatches(conversation.title, query)) continue;
    if (results.length === limit) return { results, more: true };
    sessions.add(conversation.sessionId);
    results.push({ directoryPath: directory.path, directoryName: directory.name, conversation });
  }
  return { results, more: false };
}

/** A project dir's transcripts: its files ending in `suffix`. */
function transcriptsIn(projectDir: string, suffix: string): TranscriptFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
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
