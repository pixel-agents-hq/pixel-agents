/** Kiro-specific integration settings; these do not change CLI permissions. */
export const KIRO_PROVIDER_ID = 'kiro';
export const KIRO_DISPLAY_NAME = 'Kiro CLI';
export const KIRO_AGENT_NAME = 'pixel-agents-office';
export const KIRO_AGENT_DESCRIPTION = 'Managed by Pixel Agents: live office activity hooks.';
export const KIRO_AGENT_PROMPT =
  "You are a coding assistant working in the current directory. Follow the user's instructions and the project's conventions. Tool permissions are managed by Kiro; request approval when required.";
export const KIRO_HOOK_SCRIPT_NAME = 'kiro-hook.js';
export const KIRO_SESSION_ENV = 'PIXEL_AGENTS_KIRO_SESSION_ID';
export const KIRO_EXECUTABLE_ENV = 'PIXEL_AGENTS_KIRO_EXECUTABLE';
export const KIRO_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;
export const KIRO_HOOK_TIMEOUT_SECONDS = 5;
export const KIRO_HOOK_HTTP_TIMEOUT_MS = 1500;
export const KIRO_HOOK_MAX_INPUT_BYTES = 1024 * 1024;
export const KIRO_PROFILE_MODE = 0o600;
export const KIRO_PROFILE_TMP_SUFFIX = '.pixel-agents-tmp';
export const KIRO_TURN_TOOL_ID = 'kiro-turn';
export const KIRO_READING_TOOLS = new Set([
  'read',
  'fs_read',
  'read_file',
  'list_directory',
  'grep_search',
  'file_search',
  'remote_web_search',
  'grep',
  'glob',
  'code',
  'introspect',
  'tool_search',
  'web',
  'web_fetch',
  'web_search',
]);
