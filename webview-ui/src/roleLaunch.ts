// webview-ui/src/roleLaunch.ts
//
// The two-step launch (pick a Directory, then optionally a Role) as a pure
// state machine. The React side (useRoleLaunch, RoleLaunchModal) is a thin
// adapter: it feeds events in and sends whatever `send` the reducer returns.
//
// Why the reducer owns every send: the safety rules live in the order of
// messages, not in any component.
//   - launchAgent carrying a roleId goes out only after `roleConfirmed` for the
//     step in progress, or after a preview the host already marked `trusted`
//     (and bypassPermissions is off). Never otherwise.
//   - Every reply is matched to the step in progress: rolesAvailable by
//     directoryPath; rolePreview / roleConfirmed by directoryPath + roleId (and
//     the confirmed one by sha256). A reply for anything else is a stale or
//     duplicate message and is ignored. `roleRejected` carries neither field,
//     so it can only be matched to the step in progress.

import type {
  ClientMessage,
  RoleConfirmed,
  RoleEntry,
  RolePreview,
  RoleRejected,
  RolesAvailable,
} from '../../core/src/messages.js';

/** A Role's display name is its id without the `.md` suffix (agentCreated.roleName). */
export function roleNameOf(roleId: string): string {
  return roleId.replace(/\.md$/, '');
}

export type RoleLaunchState =
  | { step: 'idle' }
  /** Directory picked; choosing a Role (or none). `roles` is null until listed. */
  | { step: 'choose'; directoryPath: string; roles: RoleEntry[] | null; error: string | null }
  /** A Role picked. `preview` is null while the host's reply is awaited. */
  | {
      step: 'preview';
      directoryPath: string;
      roleId: string;
      roles: RoleEntry[];
      preview: RolePreview | null;
      /** confirmRole sent, roleConfirmed not yet received. */
      confirming: boolean;
      error: string | null;
    }
  /** launchAgent sent with the Role; waiting for the agent (or a refusal). */
  | {
      step: 'launching';
      directoryPath: string;
      roleId: string;
      roles: RoleEntry[];
      preview: RolePreview;
    };

export const ROLE_LAUNCH_IDLE: RoleLaunchState = { step: 'idle' };

export type RoleLaunchEvent =
  | { type: 'begin'; directoryPath: string }
  | { type: 'pickRole'; roleId: string }
  | { type: 'pickNoRole' }
  | { type: 'confirm' }
  | { type: 'back' }
  | { type: 'cancel' }
  | { type: 'rolesAvailable'; msg: RolesAvailable }
  | { type: 'rolePreview'; msg: RolePreview; bypassPermissions: boolean }
  | { type: 'roleConfirmed'; msg: RoleConfirmed }
  | { type: 'roleRejected'; msg: RoleRejected }
  /** An agent appeared; `roleName` is what agentCreated carried (if any). */
  | { type: 'agentCreated'; roleName: string | undefined };

export interface RoleLaunchResult {
  state: RoleLaunchState;
  send: ClientMessage[];
}

const unchanged = (state: RoleLaunchState): RoleLaunchResult => ({ state, send: [] });

/** A trusted preview launches without a confirm step, unless bypassPermissions
 *  is on: then the operator reviews and confirms every time. */
export function previewNeedsConfirm(preview: RolePreview, bypassPermissions: boolean): boolean {
  return !preview.trusted || bypassPermissions;
}

/** Number of lines in the preview text (what the modal reports beside it). */
export function previewLineCount(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

export function roleLaunchReducer(
  state: RoleLaunchState,
  event: RoleLaunchEvent,
): RoleLaunchResult {
  switch (event.type) {
    case 'begin':
      return {
        state: { step: 'choose', directoryPath: event.directoryPath, roles: null, error: null },
        send: [{ type: 'requestRoles', directoryPath: event.directoryPath }],
      };

    case 'cancel':
      return { state: ROLE_LAUNCH_IDLE, send: [] };

    case 'pickNoRole':
      if (state.step !== 'choose') return unchanged(state);
      // The launch without a Role is the launch of old: no roleId field at all.
      return {
        state: ROLE_LAUNCH_IDLE,
        send: [{ type: 'launchAgent', directoryPath: state.directoryPath }],
      };

    case 'pickRole':
      if (state.step !== 'choose' || state.roles === null) return unchanged(state);
      if (!state.roles.some((r) => r.roleId === event.roleId)) return unchanged(state);
      return {
        state: {
          step: 'preview',
          directoryPath: state.directoryPath,
          roleId: event.roleId,
          roles: state.roles,
          preview: null,
          confirming: false,
          error: null,
        },
        send: [
          { type: 'requestRolePreview', directoryPath: state.directoryPath, roleId: event.roleId },
        ],
      };

    case 'back':
      if (state.step !== 'preview') return unchanged(state);
      return {
        state: {
          step: 'choose',
          directoryPath: state.directoryPath,
          roles: state.roles,
          error: null,
        },
        send: [],
      };

    case 'rolesAvailable':
      if (state.step !== 'choose' || event.msg.directoryPath !== state.directoryPath) {
        return unchanged(state);
      }
      return { state: { ...state, roles: event.msg.roles, error: null }, send: [] };

    case 'rolePreview': {
      // Only the awaited preview: the step in progress, same Directory + Role,
      // and nothing shown yet. A duplicate or late one never replaces what the
      // operator is reading (or has already confirmed).
      if (
        state.step !== 'preview' ||
        state.preview !== null ||
        state.confirming ||
        event.msg.directoryPath !== state.directoryPath ||
        event.msg.roleId !== state.roleId
      ) {
        return unchanged(state);
      }
      if (previewNeedsConfirm(event.msg, event.bypassPermissions)) {
        return { state: { ...state, preview: event.msg, error: null }, send: [] };
      }
      return {
        state: {
          step: 'launching',
          directoryPath: state.directoryPath,
          roleId: state.roleId,
          roles: state.roles,
          preview: event.msg,
        },
        send: [{ type: 'launchAgent', directoryPath: state.directoryPath, roleId: state.roleId }],
      };
    }

    case 'confirm':
      if (state.step !== 'preview' || state.preview === null || state.confirming) {
        return unchanged(state);
      }
      return {
        state: { ...state, confirming: true, error: null },
        send: [
          {
            type: 'confirmRole',
            directoryPath: state.directoryPath,
            roleId: state.roleId,
            sha256: state.preview.sha256,
          },
        ],
      };

    case 'roleConfirmed':
      if (
        state.step !== 'preview' ||
        !state.confirming ||
        state.preview === null ||
        event.msg.directoryPath !== state.directoryPath ||
        event.msg.roleId !== state.roleId ||
        event.msg.sha256 !== state.preview.sha256
      ) {
        return unchanged(state);
      }
      return {
        state: {
          step: 'launching',
          directoryPath: state.directoryPath,
          roleId: state.roleId,
          roles: state.roles,
          preview: state.preview,
        },
        send: [{ type: 'launchAgent', directoryPath: state.directoryPath, roleId: state.roleId }],
      };

    case 'roleRejected':
      return onRoleRejected(state, event.msg);

    case 'agentCreated':
      if (state.step === 'launching' && event.roleName === roleNameOf(state.roleId)) {
        return { state: ROLE_LAUNCH_IDLE, send: [] };
      }
      return unchanged(state);
  }
}

function onRoleRejected(state: RoleLaunchState, msg: RoleRejected): RoleLaunchResult {
  switch (state.step) {
    case 'idle':
      return unchanged(state);

    case 'choose':
      return { state: { ...state, error: msg.reason }, send: [] };

    case 'preview': {
      if (msg.code === 'untrusted') {
        // Only a confirmRole can be answered with untrusted here. With none in
        // flight it is a repeat or a stale reply, and must not fan out into
        // more preview requests.
        if (!state.confirming) return unchanged(state);
        return backToPreview(state.directoryPath, state.roleId, state.roles, msg.reason);
      }
      return { state: { ...state, confirming: false, error: msg.reason }, send: [] };
    }

    case 'launching': {
      if (msg.code === 'untrusted') {
        return backToPreview(state.directoryPath, state.roleId, state.roles, msg.reason);
      }
      // Stay on the preview that was approved; nothing launched.
      return {
        state: {
          step: 'preview',
          directoryPath: state.directoryPath,
          roleId: state.roleId,
          roles: state.roles,
          preview: state.preview,
          confirming: false,
          error: msg.reason,
        },
        send: [],
      };
    }
  }
}

/** The content may have changed under us: forget the old preview and ask again. */
function backToPreview(
  directoryPath: string,
  roleId: string,
  roles: RoleEntry[],
  reason: string,
): RoleLaunchResult {
  return {
    state: {
      step: 'preview',
      directoryPath,
      roleId,
      roles,
      preview: null,
      confirming: false,
      error: reason,
    },
    send: [{ type: 'requestRolePreview', directoryPath, roleId }],
  };
}

/** Whether this client may show the Role picker at all: only the standalone
 *  browser, and only as a privileged (non read-only) session. */
export function rolePickerAvailable(isBrowserRuntime: boolean, officeReadOnly: boolean): boolean {
  return isBrowserRuntime && !officeReadOnly;
}
