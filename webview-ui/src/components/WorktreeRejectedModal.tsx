import type { WorktreeRejection } from '../hooks/useExtensionMessages.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

/**
 * A Worktree launch the server could not make: nothing was launched and
 * nothing was left on disk, and this says why (the Directory is not a git
 * repo, no free name, git's own error). Mounted at App's top level, so both
 * shells show it.
 */
export function WorktreeRejectedModal({
  rejection,
  onClose,
}: {
  rejection: WorktreeRejection | null;
  onClose: () => void;
}) {
  return (
    <Modal isOpen={rejection !== null} onClose={onClose} title="Couldn't create the worktree">
      <div data-testid="worktree-rejected" className="flex flex-col gap-8 px-10 py-4 max-w-md">
        <p role="alert" className="text-sm m-0 break-words">
          {rejection?.reason}
        </p>
        <p className="text-xs text-text-muted m-0">No agent was launched.</p>
        <div className="flex justify-end">
          <Button variant="accent" size="sm" onClick={onClose}>
            OK
          </Button>
        </div>
      </div>
    </Modal>
  );
}
