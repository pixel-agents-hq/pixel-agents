/**
 * A file sent to a terminal from a browser ON this machine is already on its
 * disk: the terminal should get that file's own path, not a copy's.
 *
 * A browser never says where a dropped file lives -- only its name, size and
 * modification time. So the original is LOOKED FOR, by its name straight
 * under the few folders files are usually dragged from and the Directories
 * the user added -- never deeper, and
 * no search of the disk -- and it counts as found only when name, size and
 * modification time all agree. Not found is a normal answer (a file from
 * anywhere else); the sender then uploads the file and a copy is saved
 * (fileUploads.ts), as for a browser on another machine.
 */

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

import { LOCAL_FILE_MTIME_TOLERANCE_MS, LOCAL_FILE_SEARCH_TIMEOUT_MS } from '../constants.js';
import { downloadsDirectory } from './fileUploads.js';

/** What a browser knows of a file it was handed. */
export interface SentFileIdentity {
  name: string;
  size: number;
  /** `File.lastModified`: milliseconds since the epoch. */
  lastModified: number;
}

/** A browser's description of a file, or null when it isn't one: the name
 *  must be a bare file name (it is joined onto folders to look in). */
export function parseSentFileIdentity(raw: unknown): SentFileIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, size, lastModified } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return null;
  if (/[/\\\0]/.test(name)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  if (typeof lastModified !== 'number' || !Number.isFinite(lastModified)) return null;
  return { name, size, lastModified };
}

/** The folders a file is usually dragged from, on every OS: the home
 *  directory and its Desktop, Downloads and Documents. */
export function usualSourceDirectories(): string[] {
  const home = os.homedir();
  return [path.join(home, 'Desktop'), downloadsDirectory(), path.join(home, 'Documents'), home];
}

/**
 * Checks candidates in a CHILD process, which prints the first that is a
 * file of the given size and modification time. A child because a stat can
 * block forever (macOS holds a background process's first touch of a
 * protected folder until someone answers a dialog nobody sees): the child is
 * killed at the timeout, where a blocked stat in this process would hold one
 * of the few file-system threads for good.
 */
const VERIFY_SCRIPT = `
const fs = require('fs');
const q = JSON.parse(process.argv[1]);
for (const p of q.candidates) {
  try {
    const s = fs.statSync(p);
    if (s.isFile() && s.size === q.size && Math.abs(s.mtimeMs - q.lastModified) < q.tolerance) {
      process.stdout.write(p);
      break;
    }
  } catch {}
}
`;

/** Run a command, resolving with its stdout ('' when it fails or times out). */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: LOCAL_FILE_SEARCH_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true },
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });
}

/**
 * The path of the file on this machine that `file` describes, or null when
 * none of `directories` holds one (the file's name straight under each).
 */
export async function findLocalFile(
  file: SentFileIdentity,
  directories: readonly string[],
): Promise<string | null> {
  const candidates = [...new Set(directories.map((dir) => path.join(dir, file.name)))];
  const query = {
    candidates,
    size: file.size,
    lastModified: file.lastModified,
    tolerance: LOCAL_FILE_MTIME_TOLERANCE_MS,
  };
  const found = await run(process.execPath, ['-e', VERIFY_SCRIPT, JSON.stringify(query)]);
  return found === '' ? null : found;
}
