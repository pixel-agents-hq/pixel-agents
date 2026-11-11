/**
 * The Pixel Office MCP's consent copy: the Intro step and the Settings
 * confirm show exactly this (served in officeMcpConsentRequest /
 * officeMcpStatus, never duplicated in the webview). Name it "Pixel Agents
 * Office MCP" in full, "Pixel Office MCP" short — never "Office MCP".
 */

export const OFFICE_MCP_HEADLINE = 'Agents that use the office';

/** The Intro's checkbox line; the full terms are OFFICE_MCP_DISCLOSURE, behind "Read more". */
export const OFFICE_MCP_SUMMARY =
  'Agents you launch here can see and change the office, and work with each other.';

export const OFFICE_MCP_DISCLOSURE =
  'Agents you launch here get the Pixel Agents Office MCP, with a key of their own that ends ' +
  'with them: they can see the office and its agents, edit the layout, launch and close agents, ' +
  'read or type into other agents’ terminals, and open, read and type into PC shells (plain ' +
  'terminals on this machine). Nothing is written to ~/.claude, and Claude ' +
  'Code’s permission prompts still apply. Turn it off or make it read-only in Settings.';
