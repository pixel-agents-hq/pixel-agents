/**
 * What a standalone launch needs to give an agent the `dispatch_task` MCP tool,
 * and the `--mcp-config` JSON that registers the stdio shim.
 *
 * The JSON names only the interpreter and the shim's path: the capability and
 * the port travel in the PTY environment (the shim reads them from there), so
 * nothing secret is ever in argv or on disk.
 */

import { TASK_DISPATCH_MCP_SERVER_NAME } from '../constants.js';

/**
 * The single launcher switch for task dispatch. Present: launches into a
 * non-default Workspace get a capability, PIXEL_AGENTS_PORT and the shim.
 * Absent: every launch is exactly the pre-dispatch one.
 */
export interface TaskDispatchLaunch {
  /** The launching server's own listening port (never read from server.json). */
  port: number;
  /** Absolute path of the bundled stdio shim (dist/hooks/pixel-agents-mcp.js). */
  shimPath: string;
}

/** The `--mcp-config` value: one stdio server, `node <shim>`, no env, no secret. */
export function taskDispatchMcpConfig(shimPath: string): string {
  return JSON.stringify({
    mcpServers: {
      [TASK_DISPATCH_MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: [shimPath] },
    },
  });
}
