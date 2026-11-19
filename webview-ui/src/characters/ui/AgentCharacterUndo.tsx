import { useEffect, useRef } from 'react';

import { statusLineFor } from '../../officeMcp/agentCharacterEdits.js';
import { undoButtonLabel } from '../../officeMcp/agentEditStatus.js';
import { useAgentCharacterEdits } from '../../officeMcp/useAgentCharacterEdits.js';
import { useStudio } from './studio.js';
import { ViewButton } from './ViewButton.js';

/**
 * The Characters view's "Undo <agent>'s edit": reverts the newest Pixel Office MCP
 * Character edit, the same operation as undo_character_edit. Shown while the view holds
 * no unsaved draft (the server refuses an undo while one does); desktop: in the header,
 * phones: floating bottom left, above the dock, across from Save. Also speaks in the
 * view's status line: the agent's edit as it lands ("Spike created Naruto"), and why a
 * press was refused.
 */
export function AgentCharacterUndo() {
  const { cast, status } = useStudio();
  const { entry, undo } = useAgentCharacterEdits();

  // Each landing or refusal once, as it arrives (not whatever was last heard before the view opened).
  const seen = useRef(entry);
  useEffect(() => {
    if (seen.current === entry) return;
    seen.current = entry;
    const line = statusLineFor(entry);
    if (line) status(line.text, line.kind);
  }, [entry, status]);

  const label = undoButtonLabel(entry);
  if (!label || cast.dirty) return null;
  const summary = entry.undoable?.summary;
  return (
    <ViewButton
      icon="undo"
      className="chv-agent-undo"
      title={`Restore the characters from before this agent's edit${summary ? ` (${summary})` : ''}`}
      onClick={undo}
    >
      {label}
    </ViewButton>
  );
}
