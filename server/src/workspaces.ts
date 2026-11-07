/**
 * Workspaces: named groups of Directories that agents are filed under.
 *
 * The list lives in its own machine-wide file, ~/.pixel-agents/workspaces.json,
 * not in config.json: config.json is shared by VS Code and `npx pixel-agents`
 * and readConfig drops keys it does not know, so a config.json round-trip by an
 * older build would silently delete the list.
 *
 * Membership rules:
 * - the default Workspace always exists, cannot be removed, and implicitly holds
 *   every Directory no other Workspace owns (its stored directoryPaths stay empty);
 * - a Directory belongs to at most one Workspace, compared through
 *   normalizeDirectoryPath so `~/p`, `p` and `/home/me/p/` are one Directory;
 * - an agent's Workspace is decided by the Directory it launched into, and is
 *   stored on the agent. Re-assigning a Directory never moves running agents.
 *
 * An agent in the default Workspace carries no `workspaceId` at all (the
 * canonical form), so everything that never heard of Workspaces — VS Code,
 * older persisted state — is already correct.
 *
 * Reads never write. A file that cannot be read or does not have the expected
 * shape is left exactly as the user wrote it: the server runs on the default
 * alone and refuses writes rather than overwrite it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import type { Workspace } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  DEFAULT_WORKSPACE_NAME,
  LAYOUT_FILE_DIR,
  WORKSPACE_DIRECTORY_PATH_MAX_LENGTH,
  WORKSPACE_DIRECTORY_PATHS_MAX,
  WORKSPACE_ID_MAX_LENGTH,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_WRITE_FAILED_REASON,
  WORKSPACES_DIR_MODE,
  WORKSPACES_FILE_MODE,
  WORKSPACES_FILE_NAME,
  WORKSPACES_FILE_UNREADABLE_REASON,
} from './constants.js';
import { normalizeDirectoryPath } from './directories.js';

export type { Workspace };

interface WorkspaceList {
  workspaces: Workspace[];
  /** False when the file exists but could not be trusted. Writes are refused
   *  in that state, so the user's file is never replaced by our guess. */
  writable: boolean;
}

export type WorkspaceMutationResult = { ok: true } | { ok: false; reason: string };

function defaultWorkspace(): Workspace {
  return { id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, directoryPaths: [] };
}

function getWorkspacesFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, WORKSPACES_FILE_NAME);
}

// ── Reading ─────────────────────────────────────────────────

/** The parsed list, or null when the shape is wrong. Strict on purpose: a
 *  half-understood file is a file we must not rewrite. */
function parseWorkspaceList(raw: unknown): Workspace[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const entries = (raw as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(entries)) return null;

  const seenIds = new Set<string>();
  const ownedPaths = new Set<string>();
  const out: Workspace[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return null;
    const { id, name, directoryPaths } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || seenIds.has(id)) return null;
    if (typeof name !== 'string') return null;
    if (!Array.isArray(directoryPaths)) return null;
    const paths: string[] = [];
    for (const dirPath of directoryPaths) {
      if (typeof dirPath !== 'string' || dirPath.length === 0) return null;
      const key = normalizeDirectoryPath(dirPath);
      if (ownedPaths.has(key)) return null;
      ownedPaths.add(key);
      paths.push(dirPath);
    }
    seenIds.add(id);
    out.push({ id, name, directoryPaths: paths });
  }
  const defaultEntry = out.find((w) => w.id === DEFAULT_WORKSPACE_ID);
  if (!defaultEntry || defaultEntry.directoryPaths.length > 0) return null;
  return out;
}

function readWorkspaceList(): WorkspaceList {
  const filePath = getWorkspacesFilePath();
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { workspaces: [defaultWorkspace()], writable: true };
    }
    console.error('[Pixel Agents] Failed to read workspaces file:', err);
    return { workspaces: [defaultWorkspace()], writable: false };
  }
  try {
    const parsed = parseWorkspaceList(JSON.parse(text));
    if (parsed) return { workspaces: parsed, writable: true };
    console.error(
      `[Pixel Agents] ${filePath} has an unexpected structure; leaving it untouched and using only the default Workspace.`,
    );
  } catch (err) {
    console.error(
      `[Pixel Agents] ${filePath} is not valid JSON; leaving it untouched and using only the default Workspace:`,
      err,
    );
  }
  return { workspaces: [defaultWorkspace()], writable: false };
}

/** Every Workspace, default first as stored. Read fresh each call; never writes. */
export function listWorkspaces(): Workspace[] {
  return readWorkspaceList().workspaces;
}

/** The `workspacesLoaded` message for the current list. */
export function workspacesLoadedMessage(): Record<string, unknown> {
  return { type: 'workspacesLoaded', workspaces: listWorkspaces() };
}

/**
 * The Workspace a Directory path belongs to, in the canonical form: undefined
 * for the default Workspace (no path, an unassigned path, an unknown path).
 */
export function workspaceIdForDirectory(directoryPath: string | undefined): string | undefined {
  if (typeof directoryPath !== 'string') return undefined;
  const key = normalizeDirectoryPath(directoryPath);
  for (const workspace of listWorkspaces()) {
    if (workspace.id === DEFAULT_WORKSPACE_ID) continue;
    if (workspace.directoryPaths.some((owned) => normalizeDirectoryPath(owned) === key)) {
      return workspace.id;
    }
  }
  return undefined;
}

/**
 * The Workspace a session's working directory belongs to: the longest assigned
 * Directory path that is the cwd itself or one of its ancestors, compared on a
 * path boundary (`/a/b` owns `/a/b/c`, never `/a/bc`). Undefined (the default)
 * when no assigned Directory contains it.
 */
export function workspaceIdForCwd(cwd: string | undefined): string | undefined {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  const key = normalizeDirectoryPath(cwd);
  let bestId: string | undefined;
  let bestLength = -1;
  for (const workspace of listWorkspaces()) {
    if (workspace.id === DEFAULT_WORKSPACE_ID) continue;
    for (const owned of workspace.directoryPaths) {
      const ownedKey = normalizeDirectoryPath(owned);
      const prefix = ownedKey.endsWith(path.sep) ? ownedKey : ownedKey + path.sep;
      const contains = key === ownedKey || key.startsWith(prefix);
      if (contains && ownedKey.length > bestLength) {
        bestId = workspace.id;
        bestLength = ownedKey.length;
      }
    }
  }
  return bestId;
}

/**
 * Settle an externally adopted agent's Workspace from the first working
 * directory that reaches us (a transcript record or a hook SessionStart). Acts
 * once: the pending mark is cleared by the first non-empty cwd and later cwds
 * only pass through. An agent that already follows a Lead is left to the Lead.
 */
export function settleWorkspaceFromCwd(
  store: AgentStateStore,
  agentId: number,
  cwd: string | undefined,
): void {
  const agent = store.get(agentId);
  if (!agent?.workspaceCwdPending || typeof cwd !== 'string' || cwd.length === 0) return;
  agent.workspaceCwdPending = false;
  if (agent.leadAgentId !== undefined) return;
  store.setAgentWorkspace(agentId, workspaceIdForCwd(cwd));
}

/**
 * Canonicalize a workspaceId carried by an agent: the default's id and any id
 * naming no known Workspace become undefined, so an agent is never filed under
 * a Workspace that does not exist.
 */
export function normalizeWorkspaceId(workspaceId: string | undefined): string | undefined {
  if (workspaceId === undefined || workspaceId === DEFAULT_WORKSPACE_ID) return undefined;
  return listWorkspaces().some((w) => w.id === workspaceId) ? workspaceId : undefined;
}

// ── Writing ─────────────────────────────────────────────────

/**
 * Persist the list: unique tmp name, exclusive create, then rename. The tmp
 * name carries pid and a random id so two processes (or two saves) can never
 * collide on, or follow a planted file at, a predictable path. Returns false
 * (after logging) on any failure, with no tmp file left behind.
 */
function writeWorkspaceList(workspaces: Workspace[]): boolean {
  const filePath = getWorkspacesFilePath();
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: WORKSPACES_DIR_MODE });
    fs.writeFileSync(tmpPath, JSON.stringify({ workspaces }, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: WORKSPACES_FILE_MODE,
    });
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error('[Pixel Agents] Failed to write workspaces file:', err);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

/** Create workspaces.json holding only the default Workspace when it does not
 *  exist. Called once at startup; an existing file (valid or not) is never touched. */
export function ensureWorkspacesFile(): void {
  if (fs.existsSync(getWorkspacesFilePath())) return;
  writeWorkspaceList([defaultWorkspace()]);
}

// ── Validation ──────────────────────────────────────────────

interface ValidSave {
  id: string | undefined;
  name: string;
  directoryPaths: string[];
}

function reject(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Field-by-field check of an untrusted saveWorkspace payload. The wire schema
 *  is not enforced at runtime, so every type is verified here. */
function validateSave(msg: Record<string, unknown>): ValidSave | { ok: false; reason: string } {
  if (
    msg.id !== undefined &&
    (typeof msg.id !== 'string' || msg.id.length > WORKSPACE_ID_MAX_LENGTH)
  ) {
    return reject('Invalid Workspace id.');
  }
  if (typeof msg.name !== 'string') {
    return reject('Enter a Workspace name.');
  }
  const name = msg.name.trim();
  if (name.length === 0) {
    return reject('Enter a Workspace name.');
  }
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return reject(`A Workspace name can be at most ${WORKSPACE_NAME_MAX_LENGTH} characters.`);
  }
  const rawPaths = msg.directoryPaths;
  if (!Array.isArray(rawPaths)) {
    return reject('Directories must be a list of paths.');
  }
  if (rawPaths.length > WORKSPACE_DIRECTORY_PATHS_MAX) {
    return reject(`A Workspace can hold at most ${WORKSPACE_DIRECTORY_PATHS_MAX} Directories.`);
  }
  const directoryPaths: string[] = [];
  for (const entry of rawPaths) {
    if (
      typeof entry !== 'string' ||
      entry.trim().length === 0 ||
      entry.length > WORKSPACE_DIRECTORY_PATH_MAX_LENGTH
    ) {
      return reject('Every Directory must be a non-empty path.');
    }
    directoryPaths.push(entry.trim());
  }
  return { id: msg.id, name, directoryPaths };
}

// ── Mutations ───────────────────────────────────────────────

/**
 * Add (no id) or edit (known id) a Workspace. Every failure leaves the file as
 * it was and returns the reason shown to the user.
 */
export function saveWorkspace(msg: Record<string, unknown>): WorkspaceMutationResult & {
  id?: string;
} {
  const input = validateSave(msg);
  if ('ok' in input) return input;

  const list = readWorkspaceList();
  if (!list.writable) return reject(WORKSPACES_FILE_UNREADABLE_REASON);

  const editing =
    input.id === undefined ? undefined : list.workspaces.find((w) => w.id === input.id);
  if (input.id !== undefined && !editing) {
    return reject('That Workspace no longer exists.');
  }
  if (editing?.id === DEFAULT_WORKSPACE_ID && input.directoryPaths.length > 0) {
    return reject('The default Workspace holds every Directory not assigned elsewhere.');
  }

  const requested = new Set<string>();
  for (const dirPath of input.directoryPaths) {
    const key = normalizeDirectoryPath(dirPath);
    if (requested.has(key)) {
      return reject(`Directory listed more than once: ${dirPath}`);
    }
    requested.add(key);
    const owner = list.workspaces.find(
      (w) =>
        w.id !== editing?.id &&
        w.directoryPaths.some((owned) => normalizeDirectoryPath(owned) === key),
    );
    if (owner) {
      return reject(`${dirPath} already belongs to the Workspace "${owner.name}".`);
    }
  }

  const saved: Workspace = {
    id: editing?.id ?? crypto.randomUUID(),
    name: input.name,
    directoryPaths: input.directoryPaths,
  };
  const next = editing
    ? list.workspaces.map((w) => (w.id === saved.id ? saved : w))
    : [...list.workspaces, saved];
  if (!writeWorkspaceList(next)) return reject(WORKSPACE_WRITE_FAILED_REASON);
  return { ok: true, id: saved.id };
}

/** Delete a Workspace. Its Directories fall back to the default simply by no
 *  longer being listed anywhere. */
export function removeWorkspace(msg: Record<string, unknown>): WorkspaceMutationResult {
  if (typeof msg.id !== 'string' || msg.id.length === 0) {
    return reject('Invalid Workspace id.');
  }
  if (msg.id === DEFAULT_WORKSPACE_ID) {
    return reject('The default Workspace cannot be removed.');
  }
  const list = readWorkspaceList();
  if (!list.writable) return reject(WORKSPACES_FILE_UNREADABLE_REASON);
  if (!list.workspaces.some((w) => w.id === msg.id)) {
    return reject('That Workspace no longer exists.');
  }
  if (!writeWorkspaceList(list.workspaces.filter((w) => w.id !== msg.id))) {
    return reject(WORKSPACE_WRITE_FAILED_REASON);
  }
  return { ok: true };
}

// ── Client messages ─────────────────────────────────────────

/** What a host must supply to dispatch the Workspace client messages. */
export interface WorkspaceMessageDeps {
  /** Fan a message out to every connected office. */
  broadcast: (message: Record<string, unknown>) => void;
  /** Point-to-point reply to the requesting client. */
  reply: (message: Record<string, unknown>) => void;
  /** A Workspace was deleted: file its agents under the default. */
  onWorkspaceRemoved: (workspaceId: string) => void;
}

/**
 * Dispatch saveWorkspace / removeWorkspace. Returns false for anything else.
 * Success rebroadcasts the list to every office (a client learns its own save
 * or delete worked from that); failure answers only the sender.
 */
export function handleWorkspaceClientMessage(
  msg: Record<string, unknown>,
  deps: WorkspaceMessageDeps,
): boolean {
  switch (msg.type) {
    case 'saveWorkspace': {
      const result = saveWorkspace(msg);
      if (!result.ok) {
        deps.reply({ type: 'workspaceRejected', reason: result.reason });
        return true;
      }
      deps.broadcast(workspacesLoadedMessage());
      return true;
    }

    case 'removeWorkspace': {
      const result = removeWorkspace(msg);
      if (!result.ok) {
        deps.reply({ type: 'workspaceRejected', reason: result.reason });
        return true;
      }
      // Agents first, so by the time offices see the shorter list every agent
      // already names a Workspace that still exists.
      deps.onWorkspaceRemoved(msg.id as string);
      deps.broadcast(workspacesLoadedMessage());
      return true;
    }

    default:
      return false;
  }
}
