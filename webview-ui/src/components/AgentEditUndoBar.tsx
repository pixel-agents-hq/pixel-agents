import { undoButtonLabel } from '../officeMcp/agentLayoutEdits.js';
import type { AgentLayoutEditControls } from '../officeMcp/useAgentLayoutEdits.js';
import { Button } from './ui/Button.js';

/**
 * The layout editor's "Undo <agent>'s edit" (top centre while the editor holds
 * no unsaved changes): reverts the newest Pixel Office MCP layout edit, the
 * same operation as undo_layout_edit. Shows why when the server refused it.
 */
export function AgentEditUndoBar({ edits }: { edits: AgentLayoutEditControls }) {
  const { entry } = edits;
  const label = undoButtonLabel(entry);
  if (!label && !entry.refused) return null;
  return (
    <div className="absolute top-8 left-1/2 -translate-x-1/2 z-10 flex gap-4 items-center pixel-panel p-4 max-w-[90vw]">
      {label && (
        <Button
          variant="default"
          size="md"
          onClick={edits.undo}
          title="Restore the layout from before this agent's edit"
          icon="undo"
        >
          {label}
        </Button>
      )}
      {entry.refused && <span className="text-sm text-reset-text">{entry.refused}</span>}
    </div>
  );
}
