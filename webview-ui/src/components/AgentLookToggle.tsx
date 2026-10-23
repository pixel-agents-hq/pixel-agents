import { useAgentLook } from '../hooks/useAgentLook.js';
import { setAgentLook } from '../office/agentLook.js';
import { Button } from './ui/Button.js';

/**
 * The Agent Look switch for a read-only office, which has no Settings: the
 * look is a per-browser view preference (localStorage), not a server action,
 * so a wall display can flip between Clawds and the classic chibis too.
 */
export function AgentLookToggle() {
  const look = useAgentLook();
  const next = look === 'clawd' ? 'classic' : 'clawd';
  return (
    <Button
      size="sm"
      className="pointer-events-auto border-border! shadow-pixel"
      onClick={() => setAgentLook(next)}
      title={`Agent look: ${look === 'clawd' ? 'Clawd' : 'Classic'} (click for ${next === 'clawd' ? 'Clawd' : 'Classic'})`}
      aria-label="Agent look"
      data-testid="agent-look-toggle"
    >
      Look: {look === 'clawd' ? 'Clawd' : 'Classic'}
    </Button>
  );
}
