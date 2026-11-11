import { useRef } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { dismissPcShellRejection, usePcShells } from './pcShellStore.js';

/**
 * An open this office asked for that the server refused (pcShellRejected): no
 * shell started, and this says why (the shell could not start, the Directory
 * is no longer one of the PC's Area, the PC left the layout). Mounted at App's
 * top level, so both shells show it.
 */
export function PcShellRejectedModal() {
  const { rejected } = usePcShells();
  // Keep the last reason on screen while the dialog drops away.
  const last = useRef(rejected);
  if (rejected) last.current = rejected;
  const shown = rejected ?? last.current;
  if (!shown) return null;

  return (
    <Modal
      isOpen={rejected !== null}
      onClose={dismissPcShellRejection}
      title="Couldn't open the shell"
    >
      <div data-testid="pc-shell-rejected" className="flex flex-col gap-8 px-10 py-4 max-w-md">
        <p role="alert" className="text-sm m-0 break-words">
          {shown.reason}
        </p>
        <div className="flex justify-end">
          <Button variant="accent" size="sm" onClick={dismissPcShellRejection}>
            OK
          </Button>
        </div>
      </div>
    </Modal>
  );
}
