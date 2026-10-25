export const CONSENT_INSTALL_HEADLINE = 'Connect OpenClaw to Pixel Agents?';

export const CONSENT_DISCLOSURE = `Pixel Agents will install and enable a local OpenClaw plugin. The plugin observes model-call, tool-call, and session lifecycle events so OpenClaw sessions can appear as animated agents.

The plugin sends only operational metadata to Pixel Agents on this machine: hashed session and tool identifiers, tool names, lifecycle state, and the active workspace directory. It does not send prompts, replies, message bodies, tool parameters or results, credentials, tokens, or transcript content.

You can disable this connection in Pixel Agents settings. Disabling it uninstalls the Pixel Agents OpenClaw plugin.`;
