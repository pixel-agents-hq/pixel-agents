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
  WorktreeOwner,
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
import { realPath } from './pathKey.js';
import type { AgentState } from './types.js';
import { worktreePathIn } from './worktreeLocation.js';

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
/**
 * Whether `agent` runs its own session, not one it shares with its Lead:
 * background-spawn children and inline Teammates carry the Lead's session id,
 * and must not take over the Lead's entry. A Teammate with a session of its
 * own (an implicit-team or tmux one) runs it.
 */
function runsOwnSession(agent: AgentState, store: AgentStateStore): boolean {
  if (agent.spawnToolUseId) return false;
  if (agent.leadAgentId === undefined) return true;
  return store.get(agent.leadAgentId)?.sessionId !== agent.sessionId;
}

export function recordConversationLooks(
  store: AgentStateStore,
  seats: Record<string, { seatId?: string }>,
): void {
  const looks = readLooks();
  let changed = false;
  const now = Date.now();
  for (const [idStr, meta] of Object.entries(seats)) {
    const agent = store.get(Number(idStr));
    if (!agent?.sessionId || agent.palette === undefined || !runsOwnSession(agent, store)) {
      continue;
    }
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
  return transcriptIn(provider, sessionDirsFor(provider, directoryPath), sessionId);
}

/** The provider's transcript name ending (`sessionFilePattern`: `*` is the session id). */
function suffixOf(provider: HookProvider): string {
  return transcriptSuffix(provider.sessionFilePattern);
}

function transcriptIn(
  provider: HookProvider,
  dirs: readonly string[],
  sessionId: string,
): string | undefined {
  const suffix = suffixOf(provider);
  return dirs.map((dir) => path.join(dir, `${sessionId}${suffix}`)).find((f) => fs.existsSync(f));
}

/** A Worktree of a Directory (Pixel Agents' or Claude Code's), as the
 *  conversation listing and a resume need it. Its folder may be gone (a
 *  parked one of ours). */
export interface WorktreeLocation {
  name: string;
  path: string;
  branch: string;
  owner: WorktreeOwner;
}

/** A Directory's Worktrees, by its path. Required wherever conversations
 *  are listed or resumed, so no caller forgets them; a surface with no
 *  Worktrees passes `noWorktrees`. */
export type WorktreesOf = (directoryPath: string) => readonly WorktreeLocation[];

/** For a caller with no Worktrees to list. */
export const noWorktrees: WorktreesOf = () => [];

/**
 * Where a Worktree's sessions are filed: the project dirs of its folder,
 * worked out also from the Directory's resolved path, because a removed
 * folder can't be resolved itself and the CLI files sessions under the
 * resolved one (Claude Code: `<repo hash>--claude-worktrees-<name>`).
 */
export function worktreeSessionDirs(
  provider: HookProvider,
  directoryPath: string,
  worktree: { name: string; path: string },
): string[] {
  const resolved = worktreePathIn(realPath(directoryPath), worktree.name);
  return [
    ...new Set([...sessionDirsFor(provider, worktree.path), ...sessionDirsFor(provider, resolved)]),
  ];
}

/** A Worktree's newest session (any, titled or not), if it has one. */
export function latestWorktreeSession(
  provider: HookProvider,
  directoryPath: string,
  worktree: { name: string; path: string },
): string | undefined {
  const newest = worktreeSessionDirs(provider, directoryPath, worktree)
    .flatMap((dir) => transcriptsIn(dir, suffixOf(provider)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return newest && path.basename(newest.path, suffixOf(provider));
}

/**
 * Where sessions of a Directory's Worktrees that are gone for good are filed:
 * the project dirs named like one of its Worktree folders (Claude Code:
 * `<repo hash>--claude-worktrees-<name>`) that belong to none of the
 * Worktrees it has now (`known`: ours, parked ones included, and the CLI's
 * own). Removing a Worktree never deletes its sessions; these are where
 * they stay, listed under the Directory and resumed in its own checkout.
 *
 * The naming is found the way any session dir is, through the provider's
 * `getSessionDirs`, here for a probe Worktree's folder: the convention's
 * `sessionDirName` is not asked.
 */
export function removedWorktreeSessionDirs(
  provider: HookProvider,
  directoryPath: string,
  known: readonly { name: string; path: string }[],
): string[] {
  const taken = new Set(known.flatMap((w) => worktreeSessionDirs(provider, directoryPath, w)));
  // The project dir a Worktree named PROBE would have, less the name: the
  // prefix every Worktree's dir of this Directory starts with.
  const PROBE = 'pixelagentsprobe';
  const prefixes = new Set<string>();
  for (const dir of worktreeSessionDirs(provider, directoryPath, {
    name: PROBE,
    path: worktreePathIn(directoryPath, PROBE),
  })) {
    if (dir.endsWith(PROBE)) prefixes.add(dir.slice(0, -PROBE.length));
  }
  const out: string[] = [];
  for (const prefix of prefixes) {
    const root = path.dirname(prefix);
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(root, name);
      if (!dir.startsWith(prefix) || dir.length === prefix.length) continue;
      if (taken.has(dir) || out.includes(dir)) continue;
      out.push(dir);
    }
  }
  return out;
}

/**
 * Move a session of a removed Worktree into the Directory's own project dir
 * (its transcript and the folder of the same name beside it: sub-agents,
 * tool results), so the CLI, which resumes only sessions filed under the
 * folder it runs in, finds it in the Directory's checkout. Returns the
 * transcript's new path, or a reason it could not be moved (nothing moved).
 */
export function moveSessionIntoDirectory(
  provider: HookProvider,
  directoryPath: string,
  transcript: string,
): { ok: true; transcript: string } | { ok: false; reason: string } {
  const target = sessionDirsFor(provider, directoryPath)[0];
  if (!target) return { ok: false, reason: 'This coding agent files no sessions by folder.' };
  const suffix = suffixOf(provider);
  const sessionId = path.basename(transcript, suffix);
  const moved = path.join(target, `${sessionId}${suffix}`);
  const from = path.dirname(transcript);
  const folder = path.join(from, sessionId);
  try {
    if (fs.existsSync(moved)) return { ok: false, reason: `${moved} already exists.` };
    fs.mkdirSync(target, { recursive: true });
    fs.renameSync(transcript, moved);
  } catch (err) {
    return { ok: false, reason: `Couldn't move the conversation: ${(err as Error).message}` };
  }
  try {
    if (fs.existsSync(folder)) fs.renameSync(folder, path.join(target, sessionId));
  } catch (err) {
    console.warn(`[Pixel Agents] Conversations: left ${folder} behind:`, err);
  }
  try {
    fs.rmdirSync(from); // Only once nothing else is filed there.
  } catch {
    // Other sessions still there.
  }
  return { ok: true, transcript: moved };
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
  // Children and inline Teammates share their lead's session: the lead runs it.
  return new Map(
    [...store]
      .filter(([, agent]) => runsOwnSession(agent, store))
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
  /** The Directory's Worktree it ran in, when it did. */
  worktree?: WorktreeLocation;
  /** It ran in a Worktree that is gone for good: it resumes in the
   *  Directory's checkout, moved there first (`moveSessionIntoDirectory`). */
  fromRemovedWorktree?: true;
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
  worktreesOf: WorktreesOf,
): ResumeRequest | null {
  if (!provider.conversationTitle || !provider.buildLaunchCommand) return null;
  const { sessionId, directoryPath } = msg;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
  if (typeof directoryPath !== 'string') return null;
  // Already in the office: nothing to bring back.
  if ([...store].some(([, agent]) => agent.sessionId === sessionId)) return null;
  const look = conversationLook(sessionId);
  const transcript = findTranscript(provider, directoryPath, sessionId);
  if (transcript) return { sessionId, directoryPath, transcript, look };
  // Else one of its Worktrees' (only where its transcript is says which).
  const known = worktreesOf(directoryPath);
  for (const worktree of known) {
    const file = transcriptIn(
      provider,
      worktreeSessionDirs(provider, directoryPath, worktree),
      sessionId,
    );
    if (file) return { sessionId, directoryPath, transcript: file, look, worktree };
  }
  // Else a Worktree that is gone: back in the Directory's own checkout.
  const removed = transcriptIn(
    provider,
    removedWorktreeSessionDirs(provider, directoryPath, known),
    sessionId,
  );
  if (removed) {
    return { sessionId, directoryPath, transcript: removed, look, fromRemovedWorktree: true };
  }
  return null;
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

/** A transcript of a Directory, with the Worktree it ran in (if it did). */
interface DirectoryTranscript extends TranscriptFile {
  worktree?: WorktreeLocation;
}

/**
 * Every transcript of a Directory, newest first: its own sessions, then its
 * Worktrees', then those of Worktrees that are gone (each project dir read
 * once; a gone Worktree's sessions are the Directory's again).
 */
function directoryTranscripts(
  directory: Directory,
  provider: HookProvider,
  worktreesOf: WorktreesOf,
): DirectoryTranscript[] {
  const sources: Array<{ dir: string; worktree?: WorktreeLocation }> = sessionDirsFor(
    provider,
    directory.path,
  ).map((dir) => ({ dir }));
  const known = worktreesOf(directory.path);
  for (const worktree of known) {
    for (const dir of worktreeSessionDirs(provider, directory.path, worktree)) {
      if (!sources.some((s) => s.dir === dir)) sources.push({ dir, worktree });
    }
  }
  for (const dir of removedWorktreeSessionDirs(provider, directory.path, known)) {
    if (!sources.some((s) => s.dir === dir)) sources.push({ dir });
  }
  return sources
    .flatMap(({ dir, worktree }) =>
      transcriptsIn(dir, suffixOf(provider)).map((file) => ({ ...file, worktree })),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A transcript as a listed conversation, or null when it has no title (a
 *  past session that never got a prompt; a running one is "New conversation"). */
function conversationOf(
  file: DirectoryTranscript,
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
  looks: Looks,
): Conversation | null {
  const sessionId = path.basename(file.path, suffixOf(provider));
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
    ...(file.worktree
      ? { worktree: { name: file.worktree.name, branch: file.worktree.branch } }
      : {}),
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
  worktreesOf: WorktreesOf,
  limits: ReadonlyMap<string, number> = new Map(),
): DirectoryConversations[] {
  const looks = readLooks();
  const found = new Set<string>();
  const listed = directories.map((directory): DirectoryConversations => {
    const limit = limits.get(directory.path) ?? CONVERSATIONS_PER_DIRECTORY;
    const conversations: Conversation[] = [];
    let more = false;
    for (const file of directoryTranscripts(directory, provider, worktreesOf)) {
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
  worktreesOf: WorktreesOf,
  { query, directoryPath, limit }: ConversationQuery,
): { results: FoundConversation[]; more: boolean } {
  const looks = readLooks();
  const files = directories
    .filter((d) => directoryPath === undefined || d.path === directoryPath)
    .flatMap((directory) =>
      directoryTranscripts(directory, provider, worktreesOf).map((file) => ({
        file,
        directory,
      })),
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
