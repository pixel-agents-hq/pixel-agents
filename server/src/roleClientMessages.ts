/**
 * The Role client messages: requestRoles, requestRolePreview, confirmRole, and
 * launchAgent carrying a roleId. Standalone only.
 *
 * Every answer goes to the requesting client alone (`reply`), never through a
 * broadcast. Each handler is async (enumeration and reads are) and catches
 * everything itself: handleClientMessage is synchronous, so a rejection
 * escaping from here would reach no handler.
 *
 * A launch with a Role is validated completely BEFORE the launcher runs: the
 * launcher is synchronous and assigns the agent id, so a refused Role never
 * uses an id or starts a PTY. The file is read once; that one buffer is hashed,
 * checked against the trust records, and written to the snapshot claude gets.
 */

import type { RoleRejectionCode } from '../../core/src/messages.js';
import {
  PERMISSION_ROLES_INVALID_REASON,
  ROLE_BAD_CONTENT_REASON,
  ROLE_CHANGED_REASON,
  ROLE_INVALID_DIRECTORY_REASON,
  ROLE_INVALID_HASH_REASON,
  ROLE_INVALID_ID_REASON,
  ROLE_LAUNCH_FAILED_REASON,
  ROLE_LIST_FAILED_REASON,
  ROLE_MISSING_DIRECTORY_REASON,
  ROLE_NOT_LISTED_REASON,
  ROLE_REQUEST_FAILED_REASON,
  ROLE_SHA256_PATTERN,
  ROLE_STORAGE_UNSAFE_REASON,
  ROLE_TOO_LARGE_REASON,
  ROLE_TRUST_UNREADABLE_REASON,
  ROLE_UNAVAILABLE_REASON,
  ROLE_UNREADABLE_REASON,
  ROLE_UNTRUSTED_REASON,
  ROLE_WRITE_FAILED_REASON,
} from './constants.js';
import type { HostDirectoryEntry } from './directories.js';
import {
  escapeInvisibleCharacters,
  isValidRoleId,
  type ListedRole,
  listRoles,
  openRolesDirectory,
  readRoleFile,
  type RegisteredDirectory,
  resolveRegisteredDirectory,
  type RoleFileContent,
  type RolesDirectory,
} from './roles.js';
import {
  addTrustedRole,
  checkRolesStorage,
  isRoleTrusted,
  removeRoleSnapshot,
  RoleStorageUnsafeError,
  RoleTrustUnreadableError,
  writeRoleSnapshot,
} from './roleStorage.js';
import type { PermissionRoles } from './writeGuard/permissionRoles.js';
import { parsePermissionRoles } from './writeGuard/permissionRoles.js';

type Reply = (message: Record<string, unknown>) => void;

/** What launching a validated Role needs from the host. */
export interface RoleLaunchRequest {
  /** The registered Directory's path (never the client's string). */
  directoryPath: string;
  roleName: string;
  /** The listed Role's file name (its personal KB identity key). */
  roleId: string;
  snapshotPath: string;
  /** P3 permission-role override, validated here (absent: the Workspace default). */
  permissionRoles?: PermissionRoles;
}

export interface RoleMessageDeps {
  reply: Reply;
  /** This host's own Directory contributions (the registered union's host half). */
  hostDirectories: () => HostDirectoryEntry[];
  /** False in VS Code embedded mode, with the terminal off, and on Windows. */
  available: boolean;
  /**
   * Start the agent. Returns its id, or null when the launch failed -- in which
   * case the launcher has already removed the snapshot.
   */
  launch: (request: RoleLaunchRequest) => number | null;
}

/** Thrown inside a handler to answer roleRejected and stop. */
class RoleRefusal extends Error {
  constructor(
    readonly code: RoleRejectionCode,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** The roleRejected message. `reason` must be one of the fixed constants. */
export function roleRejectedMessage(
  code: RoleRejectionCode,
  reason: string,
): Record<string, unknown> {
  return { type: 'roleRejected', code, reason };
}

function refuseUnless(condition: boolean, code: RoleRejectionCode, reason: string): void {
  if (!condition) throw new RoleRefusal(code, reason);
}

function storageRefusal(err: unknown): RoleRefusal {
  if (err instanceof RoleStorageUnsafeError)
    return new RoleRefusal('io', ROLE_STORAGE_UNSAFE_REASON);
  if (err instanceof RoleTrustUnreadableError) {
    return new RoleRefusal('io', ROLE_TRUST_UNREADABLE_REASON);
  }
  return new RoleRefusal('io', ROLE_WRITE_FAILED_REASON);
}

function errnoCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.name : 'unknown');
}

/** Run a handler, turning a RoleRefusal (or anything unexpected) into roleRejected. */
async function answer(reply: Reply, handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (err) {
    if (err instanceof RoleRefusal) {
      reply(roleRejectedMessage(err.code, err.reason));
      return;
    }
    // Code only: an fs error message would carry a resolved path.
    console.error(`[Pixel Agents] Roles: request failed (${errnoCode(err)}).`);
    reply(roleRejectedMessage('io', ROLE_REQUEST_FAILED_REASON));
  }
}

// ── Shared steps ────────────────────────────────────────────

function registeredDirectoryOrRefuse(
  directoryPath: unknown,
  deps: RoleMessageDeps,
): RegisteredDirectory {
  const directory = resolveRegisteredDirectory(directoryPath, deps.hostDirectories());
  refuseUnless(directory !== null, 'invalid', ROLE_INVALID_DIRECTORY_REASON);
  return directory as RegisteredDirectory;
}

async function storageCheckedOrRefuse(): Promise<void> {
  try {
    await checkRolesStorage();
  } catch (err) {
    throw storageRefusal(err);
  }
}

async function rolesOf(directory: RegisteredDirectory): Promise<{
  rolesDirectory: RolesDirectory | null;
  roles: ListedRole[];
}> {
  let rolesDirectory: RolesDirectory | null;
  try {
    rolesDirectory = await openRolesDirectory(directory);
    return { rolesDirectory, roles: rolesDirectory ? await listRoles(rolesDirectory) : [] };
  } catch (err) {
    console.error(`[Pixel Agents] Roles: listing failed (${errnoCode(err)}).`);
    throw new RoleRefusal('io', ROLE_LIST_FAILED_REASON);
  }
}

/** The id validated, the Directory registered, the Role listed right now, and
 *  its content read once and accepted. */
async function readListedRoleOrRefuse(
  directoryPath: unknown,
  roleId: unknown,
  deps: RoleMessageDeps,
): Promise<{
  directory: RegisteredDirectory;
  rolesDirectory: RolesDirectory;
  roleId: string;
  roleName: string;
  content: RoleFileContent;
}> {
  refuseUnless(isValidRoleId(roleId), 'invalid', ROLE_INVALID_ID_REASON);
  const directory = registeredDirectoryOrRefuse(directoryPath, deps);
  const { rolesDirectory, roles } = await rolesOf(directory);
  // Exact, full-string match against what is listed; the file opened is the
  // listed entry's name, never the client's string.
  const listed = roles.find((role) => role.roleId === roleId);
  refuseUnless(rolesDirectory !== null && listed !== undefined, 'invalid', ROLE_NOT_LISTED_REASON);
  const result = await readRoleFile(rolesDirectory as RolesDirectory, listed as ListedRole);
  if (result === 'unreadable') throw new RoleRefusal('invalid', ROLE_UNREADABLE_REASON);
  if (result === 'tooLarge') throw new RoleRefusal('invalid', ROLE_TOO_LARGE_REASON);
  if (result === 'badContent') throw new RoleRefusal('invalid', ROLE_BAD_CONTENT_REASON);
  return {
    directory,
    rolesDirectory: rolesDirectory as RolesDirectory,
    roleId: (listed as ListedRole).roleId,
    roleName: (listed as ListedRole).name,
    content: result,
  };
}

async function trustedOrRefuse(entry: {
  directory: string;
  roleId: string;
  sha256: string;
}): Promise<boolean> {
  try {
    return await isRoleTrusted(entry);
  } catch (err) {
    throw storageRefusal(err);
  }
}

// ── Handlers ────────────────────────────────────────────────

async function handleRequestRoles(msg: Record<string, unknown>, deps: RoleMessageDeps) {
  refuseUnless(deps.available, 'unavailable', ROLE_UNAVAILABLE_REASON);
  const directory = registeredDirectoryOrRefuse(msg.directoryPath, deps);
  await storageCheckedOrRefuse();
  const { roles } = await rolesOf(directory);
  deps.reply({
    type: 'rolesAvailable',
    directoryPath: directory.path,
    roles: roles.map((role) => ({ roleId: role.roleId, name: role.name })),
  });
}

async function handleRequestRolePreview(msg: Record<string, unknown>, deps: RoleMessageDeps) {
  refuseUnless(deps.available, 'unavailable', ROLE_UNAVAILABLE_REASON);
  await storageCheckedOrRefuse();
  const read = await readListedRoleOrRefuse(msg.directoryPath, msg.roleId, deps);
  const trusted = await trustedOrRefuse({
    directory: read.rolesDirectory.realPath,
    roleId: read.roleId,
    sha256: read.content.sha256,
  });
  // To the sender only, and never logged: this is the one message that carries
  // a Role's content.
  deps.reply({
    type: 'rolePreview',
    directoryPath: read.directory.path,
    roleId: read.roleId,
    content: escapeInvisibleCharacters(read.content.text),
    sha256: read.content.sha256,
    size: read.content.bytes.length,
    mtime: read.content.mtime.toISOString(),
    trusted,
  });
}

async function handleConfirmRole(msg: Record<string, unknown>, deps: RoleMessageDeps) {
  refuseUnless(deps.available, 'unavailable', ROLE_UNAVAILABLE_REASON);
  refuseUnless(
    typeof msg.sha256 === 'string' && ROLE_SHA256_PATTERN.test(msg.sha256),
    'invalid',
    ROLE_INVALID_HASH_REASON,
  );
  await storageCheckedOrRefuse();
  const read = await readListedRoleOrRefuse(msg.directoryPath, msg.roleId, deps);
  // Bound to what the operator saw: re-read now, trusted only if unchanged.
  refuseUnless(read.content.sha256 === msg.sha256, 'untrusted', ROLE_CHANGED_REASON);
  try {
    await addTrustedRole({
      directory: read.rolesDirectory.realPath,
      roleId: read.roleId,
      sha256: read.content.sha256,
    });
  } catch (err) {
    if (!(err instanceof RoleStorageUnsafeError) && !(err instanceof RoleTrustUnreadableError)) {
      console.error(`[Pixel Agents] Roles: trust record write failed (${errnoCode(err)}).`);
    }
    throw storageRefusal(err);
  }
  deps.reply({
    type: 'roleConfirmed',
    directoryPath: read.directory.path,
    roleId: read.roleId,
    sha256: read.content.sha256,
  });
}

async function handleLaunchWithRole(msg: Record<string, unknown>, deps: RoleMessageDeps) {
  refuseUnless(deps.available, 'unavailable', ROLE_UNAVAILABLE_REASON);
  refuseUnless(isValidRoleId(msg.roleId), 'invalid', ROLE_INVALID_ID_REASON);
  // A Role launch never falls back to the server's cwd.
  refuseUnless(msg.directoryPath !== undefined, 'invalid', ROLE_MISSING_DIRECTORY_REASON);
  // P3: an invalid permission-role override launches nothing (never a launch without it).
  const permissionRoles =
    msg.permissionRoles === undefined ? undefined : parsePermissionRoles(msg.permissionRoles);
  refuseUnless(
    msg.permissionRoles === undefined || permissionRoles !== undefined,
    'invalid',
    PERMISSION_ROLES_INVALID_REASON,
  );
  await storageCheckedOrRefuse();
  const read = await readListedRoleOrRefuse(msg.directoryPath, msg.roleId, deps);
  const trusted = await trustedOrRefuse({
    directory: read.rolesDirectory.realPath,
    roleId: read.roleId,
    sha256: read.content.sha256,
  });
  // Never re-confirmed here: the client goes back to the preview.
  refuseUnless(trusted, 'untrusted', ROLE_UNTRUSTED_REASON);

  let snapshotPath: string;
  try {
    snapshotPath = await writeRoleSnapshot(read.content.bytes);
  } catch (err) {
    if (!(err instanceof RoleStorageUnsafeError)) {
      console.error(`[Pixel Agents] Roles: launch snapshot write failed (${errnoCode(err)}).`);
    }
    throw storageRefusal(err);
  }

  let id: number | null;
  try {
    id = deps.launch({
      directoryPath: read.directory.path,
      roleName: read.roleName,
      roleId: read.roleId,
      snapshotPath,
      ...(permissionRoles !== undefined ? { permissionRoles } : {}),
    });
  } catch (err) {
    removeRoleSnapshot(snapshotPath);
    console.error(`[Pixel Agents] Roles: launch failed (${errnoCode(err)}).`);
    throw new RoleRefusal('io', ROLE_LAUNCH_FAILED_REASON);
  }
  // The launcher removed the snapshot on every path that returns null.
  refuseUnless(id !== null, 'io', ROLE_LAUNCH_FAILED_REASON);
}

/**
 * Dispatch a Role message. Returns false for anything that is not one -- a
 * launchAgent WITHOUT a roleId included, which keeps its existing path.
 * Returns a promise for tests; callers may fire and forget (it never rejects).
 */
export function handleRoleClientMessage(
  msg: Record<string, unknown>,
  deps: RoleMessageDeps,
): Promise<void> | false {
  switch (msg.type) {
    case 'requestRoles':
      return answer(deps.reply, () => handleRequestRoles(msg, deps));
    case 'requestRolePreview':
      return answer(deps.reply, () => handleRequestRolePreview(msg, deps));
    case 'confirmRole':
      return answer(deps.reply, () => handleConfirmRole(msg, deps));
    case 'launchAgent':
      // Any roleId at all -- even a junk one -- takes the Role path and is
      // refused there, rather than launching without the Role.
      if (msg.roleId === undefined) return false;
      return answer(deps.reply, () => handleLaunchWithRole(msg, deps));
    default:
      return false;
  }
}
