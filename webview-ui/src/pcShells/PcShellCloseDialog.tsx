import { useRef } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import {
  closePcShell,
  closingForDelete,
  dismissPcShellQuestion,
  usePcShells,
} from './pcShellStore.js';

/**
 * The one question a PC shell's × asks: a command is still running in it (its
 * foreground process is not the shell), so the server kept it open and asked
 * this office. Close Shell ends it anyway; Keep Running (or dismissing) leaves it.
 *
 * Mounted at App's top level, so both shells show it.
 */
export function PcShellCloseDialog() {
  const { question } = usePcShells();
  // Keep the last question on screen while the dialog drops away.
  const last = useRef(question);
  if (question) last.current = question;
  const shown = question ?? last.current;
  if (!shown) return null;

  return (
    <Modal
      isOpen={question !== null}
      onClose={dismissPcShellQuestion}
      title="A command is still running"
    >
      <div
        data-testid="pc-shell-close-question"
        className="flex flex-col gap-8 px-10 py-4 max-w-md"
      >
        <p className="text-sm m-0 break-words">
          {shown.command ? (
            <>
              <span className="text-text">{shown.command}</span> is still running in this shell.
            </>
          ) : (
            'Something may still be running in this shell.'
          )}{' '}
          {closingForDelete()
            ? 'Deleting this PC closes its shell and stops it.'
            : 'Closing the shell stops it.'}
        </p>
        <div className="flex gap-4 justify-end">
          <Button onClick={dismissPcShellQuestion}>Keep Running</Button>
          <Button variant="accent" onClick={() => closePcShell(shown.id, true)}>
            {closingForDelete() ? 'Close Shell and Delete' : 'Close Shell'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
