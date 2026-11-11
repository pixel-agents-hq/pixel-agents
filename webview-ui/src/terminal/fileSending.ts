import { TERMINAL_UPLOAD_MAX_BYTES } from '../../../core/src/constants.js';
import { TERMINAL_FILE_STATUS_MS } from '../constants.js';
import { serverToken } from '../transport/serverToken.js';
import {
  isLoopbackHostname,
  pathsToPaste,
  terminalFileLocateUrl,
  terminalFileUrl,
  uploadFailureReason,
} from './fileUpload.js';

/**
 * Sending files to an agent's terminal: a file dropped on the pane (desktop)
 * or picked from the device (the phone's "Attach file") is uploaded to the
 * machine the agent runs on, and the path it was saved under is pasted into
 * the terminal -- what dropping a file on a native terminal types. The server
 * side (where it is saved, under what name, how the path is quoted) is
 * server/src/terminal/fileUploads.ts.
 *
 * This is the DOM half: the drop listeners, the hidden file input, the
 * upload itself and the status line laid over the pane (the upload's address
 * and wording are fileUpload.ts, DOM-free). Styling lives in index.css
 * (`.terminal-drop-target`, `.terminal-file-status`).
 */
export interface FileSender {
  /** Open the device's file picker; what is picked gets sent. Call it from a
   *  click handler (browsers open a picker only on a user's own press). */
  pickFiles(): void;
  dispose(): void;
}

/**
 * A browser on the server's own machine: the file may already be on the disk
 * the agent reads, and then its own path is what the terminal should get, with
 * no copy made. The browser can't say where a file lives, so the server looks
 * for one of this name, size and modification time; null when it finds none
 * (or the page isn't local), and the file is uploaded instead.
 */
async function locateOnServer(agentId: number, file: File, token: string): Promise<string | null> {
  if (!isLoopbackHostname(window.location.hostname)) return null;
  try {
    const response = await fetch(terminalFileLocateUrl(agentId, token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, lastModified: file.lastModified }),
    });
    if (!response.ok) return null;
    const answer = (await response.json()) as { text?: unknown };
    return typeof answer.text === 'string' && answer.text !== '' ? answer.text : null;
  } catch {
    return null;
  }
}

/** Send one file (found in place, else uploaded); resolves with its saved path as terminal text, rejects
 *  with an Error whose message is the reason to show. */
async function uploadFile(agentId: number, file: File): Promise<string> {
  if (serverToken === null) throw new Error(uploadFailureReason(401));
  const local = await locateOnServer(agentId, file, serverToken);
  if (local !== null) return local;
  // Checked here too: a server refusing a body mid-upload reads as a network
  // error in a browser, not as its answer.
  if (file.size > TERMINAL_UPLOAD_MAX_BYTES) throw new Error(uploadFailureReason(413));
  let response: Response;
  try {
    response = await fetch(terminalFileUrl(agentId, file.name, serverToken), {
      method: 'POST',
      // Always the raw-bytes type: the browser would otherwise send the
      // file's own, and the server takes only this one.
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    // Also what reading a dropped FOLDER fails with.
    throw new Error('the upload did not go through');
  }
  if (!response.ok) throw new Error(uploadFailureReason(response.status));
  const answer = (await response.json()) as { text?: unknown };
  if (typeof answer.text !== 'string' || answer.text === '') {
    throw new Error(uploadFailureReason(500));
  }
  return answer.text;
}

/** Whether a drag carries files (and not, say, selected text). */
function carriesFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes('Files') === true;
}

export function attachFileSending(
  host: HTMLElement,
  opts: {
    agentId: number;
    /** Paste the saved paths into the terminal. */
    paste: (text: string) => void;
    /** Files were dropped on the pane: the terminal takes the keyboard, as
     *  it does after a drop on a native one. */
    onDrop: () => void;
  },
): FileSender {
  let dropTarget: HTMLDivElement | null = null;
  let status: HTMLDivElement | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Uploads run one batch after another, so paths land in the order sent. */
  let queue: Promise<void> = Promise.resolve();

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  host.appendChild(input);

  const showStatus = (text: string, kind: 'busy' | 'error') => {
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = null;
    if (!status) {
      status = document.createElement('div');
      status.className = 'terminal-file-status';
      status.setAttribute('role', 'status');
      host.appendChild(status);
    }
    status.textContent = text;
    status.dataset.kind = kind;
    // A failure stays long enough to read; progress stays until replaced.
    if (kind === 'error') statusTimer = setTimeout(hideStatus, TERMINAL_FILE_STATUS_MS);
  };
  const hideStatus = () => {
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = null;
    status?.remove();
    status = null;
  };

  const sendBatch = async (files: readonly File[]) => {
    const sent: string[] = [];
    const failures: string[] = [];
    for (const file of files) {
      if (disposed) return;
      showStatus(`Sending ${file.name}…`, 'busy');
      try {
        sent.push(await uploadFile(opts.agentId, file));
      } catch (err) {
        const reason = err instanceof Error ? err.message : uploadFailureReason(500);
        failures.push(`Couldn't send ${file.name}: ${reason}`);
        console.warn(`[Webview] Terminal: sending ${file.name} failed (${reason})`);
      }
    }
    if (disposed) return;
    const text = pathsToPaste(sent);
    if (text) opts.paste(text);
    if (failures.length > 0) showStatus(failures.join(' · '), 'error');
    else hideStatus();
  };

  const send = (files: readonly File[]) => {
    if (files.length === 0) return;
    queue = queue.then(() => sendBatch(files));
  };

  const showDropTarget = () => {
    if (dropTarget) return;
    dropTarget = document.createElement('div');
    dropTarget.className = 'terminal-drop-target';
    dropTarget.textContent = 'Drop to send to this agent';
    host.appendChild(dropTarget);
  };
  const hideDropTarget = () => {
    dropTarget?.remove();
    dropTarget = null;
  };

  // dragover must be cancelled for the pane to be a drop target at all;
  // uncancelled, the browser's own answer to a dropped file is to navigate
  // to it, away from the office.
  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    showDropTarget();
  };
  const onDragLeave = (e: DragEvent) => {
    // Moving between the pane's own children fires leave/enter pairs; only
    // leaving the pane itself counts.
    if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) return;
    hideDropTarget();
  };
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    hideDropTarget();
    opts.onDrop();
    send(Array.from(e.dataTransfer?.files ?? []));
  };
  const onPicked = () => {
    const files = Array.from(input.files ?? []);
    // Reset so picking the same file again fires change again.
    input.value = '';
    send(files);
  };

  host.addEventListener('dragover', onDragOver);
  host.addEventListener('dragleave', onDragLeave);
  host.addEventListener('drop', onDrop);
  input.addEventListener('change', onPicked);

  return {
    pickFiles: () => input.click(),
    dispose() {
      disposed = true;
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
      input.removeEventListener('change', onPicked);
      input.remove();
      hideDropTarget();
      hideStatus();
    },
  };
}
