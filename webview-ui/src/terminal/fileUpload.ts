/**
 * Sending files to a terminal, the DOM-free part: where an upload goes, how
 * a refusal reads, and what is pasted once the files arrived. The DOM half
 * (drop, picker, status line) is fileSending.ts.
 */
import {
  TERMINAL_FILES_API_PREFIX,
  TERMINAL_FILES_LOCATE_SUFFIX,
} from '../../../core/src/constants.js';

/** The drag types that mean "files from the device": the standard one, and
 *  the one Firefox names its own file items by. */
const FILE_DRAG_TYPES = ['Files', 'application/x-moz-file'];

/** Whether a drag carries files (and not, say, selected text): by its types
 *  (all a browser tells before the drop), or by the files a drop holds. */
export function dragCarriesFiles(types: ArrayLike<string>, fileCount = 0): boolean {
  return fileCount > 0 || Array.from(types).some((type) => FILE_DRAG_TYPES.includes(type));
}

/** Whether a page's hostname is this machine's loopback: the browser and the
 *  server share a disk, so a sent file may already be where the agent can
 *  read it. (Through a proxy name, the browser is somewhere else.) */
export function isLoopbackHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
}

/** Where the server is asked whether a file is already on its disk. */
export function terminalFileLocateUrl(agentId: number, token: string): string {
  const query = new URLSearchParams({ token });
  return `${TERMINAL_FILES_API_PREFIX}/${String(agentId)}/files${TERMINAL_FILES_LOCATE_SUFFIX}?${query.toString()}`;
}

/** Where a file for `agentId` is POSTed, carrying the token the way the
 *  terminal socket does (the server's request log redacts it). */
export function terminalFileUrl(agentId: number, fileName: string, token: string): string {
  const query = new URLSearchParams({ name: fileName, token });
  return `${TERMINAL_FILES_API_PREFIX}/${String(agentId)}/files?${query.toString()}`;
}

/** Why an upload the server refused failed, in the status line's words. */
export function uploadFailureReason(status: number): string {
  if (status === 413) return 'too large';
  if (status === 401 || status === 403) return 'not allowed from this page';
  if (status === 404) return 'this terminal is gone';
  return 'the server could not save it';
}

/** What goes into the terminal for the files that arrived: their paths, a
 *  space between them and one after, so the next thing typed is not glued
 *  to the last path. Nothing when none arrived. */
export function pathsToPaste(texts: readonly string[]): string {
  return texts.length === 0 ? '' : `${texts.join(' ')} `;
}
