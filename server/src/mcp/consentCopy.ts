/**
 * The Pixel Office MCP's consent copy: the Intro step and the Settings
 * confirm show exactly this (served in officeMcpConsentRequest /
 * officeMcpStatus, never duplicated in the webview). Name it "Pixel Agents
 * Office MCP" in full, "Pixel Office MCP" short — never "Office MCP".
 */

export const OFFICE_MCP_HEADLINE = 'Let agents use the office?';

export const OFFICE_MCP_DISCLOSURE = [
  'The Pixel Agents Office MCP lets the agents you launch from this office see and act on it: ' +
    'list the agents here and what they are doing, read and edit the office layout, launch and ' +
    'close agents, and read or type into other agents’ terminals.',
  'Each agent gets its own key when it launches, passed to it with --mcp-config. It stops ' +
    'working when the agent leaves, when this server stops, or when you turn this off. Nothing ' +
    'is written to your ~/.claude files, and agents started outside the office never get it.',
  'Claude Code’s own permission prompts still apply. Change this any time in Settings, or ' +
    'make it read-only so agents can look but not change anything.',
].join('\n\n');
