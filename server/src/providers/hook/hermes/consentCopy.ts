export function hermesConsentDisclosure(): { headline: string; disclosure: string } {
  return {
    headline: 'Show Hermes Agent activity in Pixel Agents?',
    disclosure:
      'Pixel Agents will add signed, local-only outbound webhook entries to your Hermes config.yaml. It preserves unrelated settings and creates one recoverable backup before the first change.\n\n' +
      'Hermes will send session lifecycle and working-directory metadata; tool names, inputs, results, and errors; subagent lifecycle, role, and goal metadata; and approval request/response payloads, including raw commands and choices, to each running Pixel Agents server on 127.0.0.1. A local HMAC secret is stored in the Hermes config so Pixel Agents can authenticate each delivery. Pixel Agents reduces these local deliveries to visual state without retaining command, result, error, or decision payloads. It observes only; it cannot approve actions or write back to Hermes.\n\n' +
      'A Hermes process must be started after installation to load the entries. Turning Hermes off in Pixel Agents removes only entries managed by Pixel Agents.',
  };
}
