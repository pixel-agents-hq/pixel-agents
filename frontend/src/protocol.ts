import type { AgentKbTarget, WorkspaceKbTarget } from '../../core/src/messages';

export type {
  AgentActivityStatus,
  AgentKbTarget,
  ClientMessage,
  CuratorBinding,
  CuratorBindingChanged,
  Directory,
  GuardInactiveReason,
  KbFileEntry,
  KbFileRead,
  KbFilesListed,
  KbRejected,
  KbRejectionReason,
  ListKbFiles,
  PermissionRole,
  ReadKbFile,
  ServerMessage,
  Workspace,
  WorkspaceKbTarget,
} from '../../core/src/messages';
/** 一個 KB 請求所指的對象（個人 KB 或工作空間 KB），與回覆中回傳的 target 同型。 */
export type KbTarget = AgentKbTarget | WorkspaceKbTarget;
export { DEFAULT_WORKSPACE_ID, TERMINAL_WS_PREFIX } from '../../core/src/constants';
export { parseServerFrame } from '../../core/src/terminalFrames';
