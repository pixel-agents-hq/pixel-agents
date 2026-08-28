export function hermesConsentDisclosure(): { headline: string; disclosure: string } {
  return {
    headline: 'Show Hermes Agent activity in Pixel Agents?',
    disclosure:
      'Pixel Agents will add signed, local-only outbound webhook entries to your Hermes config.yaml. It preserves unrelated settings and creates one recoverable backup before the first change.\n\n' +
      'Hermes will send session lifecycle, tool names and inputs, subagent lifecycle, and approval-state metadata to each running Pixel Agents server on 127.0.0.1. A local HMAC secret is stored in the Hermes config so Pixel Agents can authenticate each delivery. Pixel Agents observes these events only; it cannot approve actions or write back to Hermes.\n\n' +
      'A Hermes process must be started after installation to load the entries. Turning Hermes off in Pixel Agents removes only entries managed by Pixel Agents.',
  };
}
