import { TERMINAL_UPLOAD_MAX_BYTES } from '../../../core/src/constants.js';
import { TERMINAL_FILE_STATUS_MS } from '../constants.js';
import { serverToken } from '../transport/serverToken.js';
import {
  dragCarriesFiles,
  isLoopbackHostname,
  pasteCarriesFiles,
  pathsToPaste,
  terminalFileLocateUrl,
  terminalFileUrl,
  uploadFailureReason,
} from './fileUpload.js';

/**
 * Sending files to an agent's terminal: a file dropped on the pane or pasted
 * into it (desktop: a copied screenshot, files copied in the file manager),
 * or picked from the device (the phone's "Attach file"), is uploaded to the
 * machine the agent runs on, and the path it was saved under is pasted into
 * the terminal -- what dropping a file on a native terminal types. The server
 * side (where it is saved, under what name, how the path is quoted) is
 * server/src/terminal/fileUploads.ts.
 *
 * This is the DOM half: the page's drop listeners, the pane's paste listener, the hidden file input, the
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

/** What a pane does with a file drag: show or hide its frame, take the files. */
interface DropPane {
  show(): void;
  hide(): void;
  drop(files: readonly File[]): void;
}

/**
 * File drags are handled ONCE for the whole page, in the capture phase on
 * `window`, and routed to the pane under the pointer. Two reasons it is not
 * a listener per pane:
 *
 * - A dropped file the page does not cancel is opened by the browser in
 *   place of the office. That must never happen, wherever the file lands
 *   (the card bar, the pane's edge) and whatever sits between the pane and
 *   the drop: a per-pane bubble listener is skipped by anything that stops
 *   the event, and Firefox on Windows did open the file.
 * - The pane is found from the pointer when the event's path does not name
 *   it, so it does not depend on which node the browser addresses the drag to.
 */
const dropPanes = new Map<HTMLElement, DropPane>();
let shownPane: DropPane | null = null;

function carriesFiles(e: DragEvent): boolean {
  return dragCarriesFiles(e.dataTransfer?.types ?? [], e.dataTransfer?.files.length ?? 0);
}

function paneOf(node: unknown): DropPane | null {
  for (let el = node instanceof Node ? node : null; el; el = el.parentNode) {
    const pane = el instanceof HTMLElement ? dropPanes.get(el) : undefined;
    if (pane) return pane;
  }
  return null;
}

function paneUnder(e: DragEvent): DropPane | null {
  for (const node of e.composedPath()) {
    const pane = node instanceof HTMLElement ? dropPanes.get(node) : undefined;
    if (pane) return pane;
  }
  return paneOf(document.elementFromPoint(e.clientX, e.clientY));
}

function showPane(pane: DropPane | null): void {
  if (pane === shownPane) return;
  shownPane?.hide();
  shownPane = pane;
  pane?.show();
}

// dragenter and dragover must both be cancelled for the page to be a drop
// target at all; off a pane the drop is refused (`none`), never navigated to.
function onWindowDragOver(e: DragEvent): void {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const pane = paneUnder(e);
  if (e.dataTransfer) e.dataTransfer.dropEffect = pane ? 'copy' : 'none';
  showPane(pane);
}

function onWindowDragLeave(e: DragEvent): void {
  // Moving between a pane's own children fires leave/enter pairs; only
  // leaving the pane counts (no related target = it left the window).
  if (shownPane !== null && paneOf(e.relatedTarget) !== shownPane) showPane(null);
}

function onWindowDrop(e: DragEvent): void {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const pane = paneUnder(e);
  showPane(null);
  pane?.drop(Array.from(e.dataTransfer?.files ?? []));
}

function registerDropPane(host: HTMLElement, pane: DropPane): () => void {
  if (dropPanes.size === 0) {
    window.addEventListener('dragenter', onWindowDragOver, true);
    window.addEventListener('dragover', onWindowDragOver, true);
    window.addEventListener('dragleave', onWindowDragLeave, true);
    window.addEventListener('drop', onWindowDrop, true);
  }
  dropPanes.set(host, pane);
  return () => {
    if (shownPane === pane) showPane(null);
    dropPanes.delete(host);
    if (dropPanes.size > 0) return;
    window.removeEventListener('dragenter', onWindowDragOver, true);
    window.removeEventListener('dragover', onWindowDragOver, true);
    window.removeEventListener('dragleave', onWindowDragLeave, true);
    window.removeEventListener('drop', onWindowDrop, true);
  };
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

  const onPicked = () => {
    const files = Array.from(input.files ?? []);
    // Reset so picking the same file again fires change again.
    input.value = '';
    send(files);
  };

  const unregister = registerDropPane(host, {
    show: showDropTarget,
    hide: hideDropTarget,
    drop: (files) => {
      opts.onDrop();
      send(files);
    },
  });
  input.addEventListener('change', onPicked);

  // A paste of files (Ctrl+V / Cmd+V with a screenshot or copied files on the
  // clipboard) is sent like a drop. Caught on its way down to xterm's
  // textarea, which would otherwise paste the clipboard's text, if any (a
  // copied file's name); a paste of text is left to it.
  const onPaste = (e: ClipboardEvent) => {
    const data = e.clipboardData;
    if (!data || !pasteCarriesFiles(data.types, data.files.length)) return;
    e.preventDefault();
    e.stopPropagation();
    send(Array.from(data.files));
  };
  host.addEventListener('paste', onPaste, true);

  return {
    pickFiles: () => input.click(),
    dispose() {
      disposed = true;
      unregister();
      input.removeEventListener('change', onPicked);
      host.removeEventListener('paste', onPaste, true);
      input.remove();
      hideDropTarget();
      hideStatus();
    },
  };
}
