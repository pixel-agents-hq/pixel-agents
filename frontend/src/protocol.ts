export type {
  AgentActivityStatus,
  ClientMessage,
  Directory,
  GuardInactiveReason,
  PermissionRole,
  ServerMessage,
  Workspace,
} from '../../core/src/messages';
export { DEFAULT_WORKSPACE_ID, TERMINAL_WS_PREFIX } from '../../core/src/constants';
export { parseServerFrame } from '../../core/src/terminalFrames';
