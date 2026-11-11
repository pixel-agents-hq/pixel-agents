/**
 * Workspaces in the webview: which agents the office shows, the attention
 * badges on the other tabs, and which Directories a launch may pick.
 *
 * Everything here is a pure function of `WorkspaceViewState`, so the rules are
 * testable without React or a DOM; useExtensionMessages only feeds messages in
 * and the components only read results out.
 *
 * The wire form is the server's canonical one: an agent in the default
 * Workspace carries NO workspaceId, so a message without one (VS Code, an older
 * server) already lands in the right place. `workspaces === null` means no
 * workspacesLoaded has arrived — then nothing is filtered at all.
 *
 * Membership is stored once, on the agent. A Teammate follows its Lead because
 * the server says so (a workspaceId inherited at creation, one
 * agentWorkspaceChanged each when the Lead moves); the one thing decided here
 * is inheritance for a Teammate created without one. A Sub-agent is not an
 * entry at all: the office judges it by its parent.
 */

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import type { Workspace } from '../../core/src/messages.js';
import { MOBILE_TOUCH_TARGET_MIN_PX } from './constants.js';

export { DEFAULT_WORKSPACE_ID };
export type { Workspace };

export interface WorkspaceViewState {
  /** The server's list (default first), or null before workspacesLoaded. */
  workspaces: Workspace[] | null;
  /** agentId → workspaceId, non-default entries only. */
  agentWorkspaceIds: Record<number, string>;
  /** In memory only: a reload starts on the default Workspace. */
  activeWorkspaceId: string;
}

export const INITIAL_WORKSPACE_VIEW: WorkspaceViewState = {
  workspaces: null,
  agentWorkspaceIds: {},
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
};

// ── Membership ──────────────────────────────────────────────

/** A workspace id as stored: absent and the default's id both mean default. */
function canonicalWorkspaceId(raw: string | undefined): string | undefined {
  return raw === undefined || raw === DEFAULT_WORKSPACE_ID ? undefined : raw;
}

function withAgentWorkspace(
  ids: Record<number, string>,
  agentId: number,
  workspaceId: string | undefined,
): Record<number, string> {
  const canonical = canonicalWorkspaceId(workspaceId);
  if (ids[agentId] === canonical) return ids;
  const next = { ...ids };
  if (canonical === undefined) delete next[agentId];
  else next[agentId] = canonical;
  return next;
}

/** The Workspace an agent is filed under. An id the list does not know (a
 *  Workspace removed while the agent's change is still in flight) is the
 *  default, which is also what the server does with it. */
export function workspaceOfAgent(view: WorkspaceViewState, agentId: number): string {
  const id = view.agentWorkspaceIds[agentId];
  if (id === undefined) return DEFAULT_WORKSPACE_ID;
  if (view.workspaces !== null && !view.workspaces.some((w) => w.id === id)) {
    return DEFAULT_WORKSPACE_ID;
  }
  return id;
}

/** Whether the office shows this top-level agent. Before any workspacesLoaded
 *  (VS Code, an older server) everything shows. */
export function isAgentVisible(view: WorkspaceViewState, agentId: number): boolean {
  if (view.workspaces === null) return true;
  return workspaceOfAgent(view, agentId) === view.activeWorkspaceId;
}

export function visibleAgentIds(view: WorkspaceViewState, agentIds: number[]): number[] {
  if (view.workspaces === null) return agentIds;
  return agentIds.filter((id) => isAgentVisible(view, id));
}

// ── Reducers (one per message) ──────────────────────────────

export function applyWorkspacesLoaded(
  view: WorkspaceViewState,
  workspaces: Workspace[],
): WorkspaceViewState {
  // The active Workspace was removed (here or from another office): fall back
  // to the default rather than show an office no tab selects.
  const stillThere = workspaces.some((w) => w.id === view.activeWorkspaceId);
  return {
    ...view,
    workspaces,
    activeWorkspaceId: stillThere ? view.activeWorkspaceId : DEFAULT_WORKSPACE_ID,
  };
}

export function applyAgentCreated(
  view: WorkspaceViewState,
  created: { id: number; workspaceId?: string; leadAgentId?: number },
): WorkspaceViewState {
  // A Teammate always belongs to its Lead's Workspace: if the message did not
  // say, take the Lead's rather than the default.
  const workspaceId =
    created.workspaceId === undefined && created.leadAgentId !== undefined
      ? view.agentWorkspaceIds[created.leadAgentId]
      : created.workspaceId;
  const next = withAgentWorkspace(view.agentWorkspaceIds, created.id, workspaceId);
  return next === view.agentWorkspaceIds ? view : { ...view, agentWorkspaceIds: next };
}

/** existingAgents re-announces every live agent, so it replaces the map
 *  wholesale (keys arrive as strings off the wire). */
export function applyExistingAgents(
  view: WorkspaceViewState,
  workspaceIds: Record<string, string> | undefined,
): WorkspaceViewState {
  const next: Record<number, string> = {};
  for (const [key, workspaceId] of Object.entries(workspaceIds ?? {})) {
    const canonical = canonicalWorkspaceId(workspaceId);
    if (canonical !== undefined) next[Number(key)] = canonical;
  }
  return { ...view, agentWorkspaceIds: next };
}

export function applyAgentWorkspaceChanged(
  view: WorkspaceViewState,
  agentId: number,
  workspaceId: string,
): WorkspaceViewState {
  const next = withAgentWorkspace(view.agentWorkspaceIds, agentId, workspaceId);
  return next === view.agentWorkspaceIds ? view : { ...view, agentWorkspaceIds: next };
}

export function applyAgentClosed(view: WorkspaceViewState, agentId: number): WorkspaceViewState {
  return applyAgentWorkspaceChanged(view, agentId, DEFAULT_WORKSPACE_ID);
}

/** Switch tabs. An id the list does not hold is ignored. */
export function selectWorkspace(view: WorkspaceViewState, workspaceId: string): WorkspaceViewState {
  if (view.workspaces === null || !view.workspaces.some((w) => w.id === workspaceId)) return view;
  return view.activeWorkspaceId === workspaceId
    ? view
    : { ...view, activeWorkspaceId: workspaceId };
}

/** A new agent is auto-selected only if the office shows it: one that appears
 *  in another Workspace (an adopted external session) must not take the
 *  selection or the camera from an agent the user can see. Call after
 *  applyAgentCreated so the agent's own Workspace is known. */
export function shouldAutoSelectNewAgent(view: WorkspaceViewState, agentId: number): boolean {
  return isAgentVisible(view, agentId);
}

// ── Switcher ────────────────────────────────────────────────

/** The switcher belongs to the standalone browser office once the server has
 *  sent its list; VS Code, and a server that never heard of Workspaces, never
 *  show it. */
export function shouldShowWorkspaceSwitcher(input: {
  isBrowserRuntime: boolean;
  workspaces: Workspace[] | null;
}): boolean {
  return input.isBrowserRuntime && input.workspaces !== null;
}

/** Edit and delete live in one modal; the default Workspace has neither. */
export function canEditWorkspace(workspaceId: string): boolean {
  return workspaceId !== DEFAULT_WORKSPACE_ID;
}

/** What a tab's badge says about an agent: it is blocked on a permission, or it
 *  finished a turn and waits. */
export type AgentAttention = 'permission' | 'waiting' | null;

export interface WorkspaceBadge {
  permission: number;
  waiting: number;
}

const NO_BADGE: WorkspaceBadge = { permission: 0, waiting: 0 };

/** Counts for every Workspace EXCEPT the active one — its agents are on
 *  screen, so a badge there would only repeat the office. Absent key = none. */
export function computeWorkspaceBadges(
  view: WorkspaceViewState,
  agentIds: number[],
  attentionOf: (agentId: number) => AgentAttention,
): Record<string, WorkspaceBadge> {
  const badges: Record<string, WorkspaceBadge> = {};
  if (view.workspaces === null) return badges;
  for (const agentId of agentIds) {
    const workspaceId = workspaceOfAgent(view, agentId);
    if (workspaceId === view.activeWorkspaceId) continue;
    const attention = attentionOf(agentId);
    if (attention === null) continue;
    const current = badges[workspaceId] ?? NO_BADGE;
    badges[workspaceId] =
      attention === 'permission'
        ? { ...current, permission: current.permission + 1 }
        : { ...current, waiting: current.waiting + 1 };
  }
  return badges;
}

/** Minimum size of a switcher control: finger-sized on the phone shell, left to
 *  the button's own padding on desktop. */
export function switcherTouchTargetStyle(
  touchTargets: boolean,
): { minHeight: number; minWidth: number } | undefined {
  return touchTargets
    ? { minHeight: MOBILE_TOUCH_TARGET_MIN_PX, minWidth: MOBILE_TOUCH_TARGET_MIN_PX }
    : undefined;
}

/** Spoken form of a tab: its name plus whatever its badge shows. */
export function workspaceTabLabel(name: string, badge: WorkspaceBadge | undefined): string {
  const parts = [name];
  if (badge && badge.permission > 0) parts.push(`${badge.permission} need permission`);
  if (badge && badge.waiting > 0) parts.push(`${badge.waiting} waiting`);
  return parts.join(', ');
}

// ── Directories ─────────────────────────────────────────────

const WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/**
 * A comparison key for a Directory path, matching the server's
 * normalizeDirectoryPath (path.resolve, lower-cased on win32) for the paths
 * this office actually holds: Directory.path is absolute and already expanded
 * by the host when it was saved, and workspace.directoryPaths are those same
 * strings sent back. So this only has to fold what resolve would: repeated and
 * trailing separators, and case on a Windows-shaped path. It does NOT resolve
 * `.`/`..` segments or `~`; a path that needs that compares unequal here, so it
 * is treated as unassigned (default Workspace) — never as another's.
 */
export function directoryPathKey(raw: string): string {
  const windows = WINDOWS_PATH.test(raw);
  let key = windows ? raw.replace(/\\/g, '/').toLowerCase() : raw;
  const unc = windows && key.startsWith('//');
  key = key.replace(/\/{2,}/g, '/');
  if (unc) key = `/${key}`;
  if (key.length > 1 && key.endsWith('/') && !/^[a-z]:\/$/.test(key)) key = key.slice(0, -1);
  return key;
}

/** The non-default Workspace that owns this path, if any. */
export function workspaceOwningDirectory(
  workspaces: Workspace[],
  path: string,
): Workspace | undefined {
  const key = directoryPathKey(path);
  return workspaces.find(
    (w) =>
      w.id !== DEFAULT_WORKSPACE_ID &&
      w.directoryPaths.some((owned) => directoryPathKey(owned) === key),
  );
}

/** The Directories a launch may pick in the active Workspace: a non-default
 *  one's own; the default's are those no other Workspace claims. */
export function directoriesForWorkspace<T extends { path: string }>(
  directories: T[],
  workspaces: Workspace[] | null,
  workspaceId: string,
): T[] {
  if (workspaces === null) return directories;
  return directories.filter((directory) => {
    const owner = workspaceOwningDirectory(workspaces, directory.path);
    return workspaceId === DEFAULT_WORKSPACE_ID ? owner === undefined : owner?.id === workspaceId;
  });
}

// ── Editing round trip ──────────────────────────────────────

/** A workspace write waiting for the server's word. */
export type PendingWorkspaceMutation =
  | { kind: 'save'; id?: string; name: string; directoryPaths: string[] }
  | { kind: 'remove'; id: string };

function sameDirectoryPaths(a: string[], b: string[]): boolean {
  const keys = new Set(a.map(directoryPathKey));
  return (
    keys.size === new Set(b.map(directoryPathKey)).size &&
    b.every((p) => keys.has(directoryPathKey(p)))
  );
}

/** Whether a rebroadcast list already contains the pending write. A save has no
 *  ack of its own (a rejection is the only reply), so this is how the modal
 *  tells its own write coming back from another office's unrelated change. */
export function isMutationApplied(
  pending: PendingWorkspaceMutation,
  workspaces: Workspace[],
): boolean {
  if (pending.kind === 'remove') return !workspaces.some((w) => w.id === pending.id);
  return workspaces.some(
    (w) =>
      (pending.id === undefined || w.id === pending.id) &&
      w.name === pending.name &&
      sameDirectoryPaths(w.directoryPaths, pending.directoryPaths),
  );
}

/** The paths to send for a checked set: what the list shows as ticked, plus any
 *  path the Workspace already owns that the list no longer offers (a removed
 *  Directory, or a host one hidden by the setting) — editing must not silently
 *  drop what it cannot display. */
export function workspacePathsToSave(
  checkedPaths: string[],
  listedPaths: string[],
  ownedPaths: string[],
): string[] {
  const listedKeys = new Set(listedPaths.map(directoryPathKey));
  const unlisted = ownedPaths.filter((p) => !listedKeys.has(directoryPathKey(p)));
  return [...checkedPaths, ...unlisted];
}
