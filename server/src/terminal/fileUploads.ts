/**
 * Files sent to a terminal: where they are saved and under what name.
 *
 * A file dropped on a terminal (or attached from the phone) is uploaded to
 * the machine the agent runs on, saved in the upload directory, and its path
 * is pasted into the terminal -- what dragging a file onto a native terminal
 * does. The route is in terminalRoutes.ts; this module is the file side.
 *
 * Unless the user chose a folder, files land in one of our own
 * (~/.pixel-agents/uploads), which is swept: old files go, and the oldest
 * when it grows too large. A folder the user chose is theirs and is never
 * swept -- nothing there says which files are ours.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';

import {
  DOWNLOADS_DIRECTORY_NAME,
  PIXEL_AGENTS_DIR,
  UPLOAD_FALLBACK_FILE_NAME,
  UPLOAD_FILE_NAME_MAX_LENGTH,
  UPLOAD_MAX_AGE_MS,
  UPLOAD_NAME_ATTEMPTS,
  UPLOAD_SWEEP_INTERVAL_MS,
  UPLOADS_DIRECTORY_NAME,
  UPLOADS_MAX_TOTAL_BYTES,
  XDG_USER_DIRS_FILE_NAME,
} from '../constants.js';

/** A path under the home directory, written with `~` (either separator, so
 *  a Windows user's `~\Desktop` works): the part after it, '' for `~` alone. */
function underHome(value: string): string | null {
  if (value === '~') return '';
  return value.startsWith('~/') || value.startsWith('~\\') ? value.slice(2) : null;
}

/**
 * The upload directory setting as it is stored, from what a client sent: a
 * trimmed absolute path or one under `~`, '' for the default. Null when it is
 * neither (a relative path would land wherever the server was started).
 */
export function parseUploadDirectory(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || underHome(value) !== null || path.isAbsolute(value)) return value;
  return null;
}

/**
 * Linux keeps the Downloads folder's place in `user-dirs.dirs` (it is named
 * in the desktop's language: `Descargas`, `Téléchargements`): the
 * `XDG_DOWNLOAD_DIR` line of that file's text, absolute or under `$HOME`.
 * Null when the file doesn't say, or says the home directory itself (how
 * xdg-user-dirs writes "no such folder").
 */
export function xdgDownloadDirectory(userDirs: string, home: string): string | null {
  const match = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"]*)"\s*$/m.exec(userDirs);
  if (!match) return null;
  const value = match[1];
  const resolved = value.startsWith('$HOME/')
    ? path.join(home, value.slice('$HOME/'.length))
    : path.isAbsolute(value)
      ? path.normalize(value)
      : null;
  if (resolved === null || path.relative(resolved, home) === '') return null;
  return resolved;
}

/** This machine's Downloads folder: `Downloads` under the home directory
 *  (macOS, Windows, and Linux unless its desktop says otherwise). */
export function downloadsDirectory(): string {
  const home = os.homedir();
  if (process.platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    try {
      const userDirs = fs.readFileSync(path.join(configHome, XDG_USER_DIRS_FILE_NAME), 'utf-8');
      const fromDesktop = xdgDownloadDirectory(userDirs, home);
      if (fromDesktop) return fromDesktop;
    } catch {
      // No such file (a server without a desktop): the conventional name.
    }
  }
  return path.join(home, DOWNLOADS_DIRECTORY_NAME);
}

/** Our own uploads folder: where files land unless the user chose a folder,
 *  and the only folder ever swept. */
export function defaultUploadDirectory(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, UPLOADS_DIRECTORY_NAME);
}

/** The directory files are saved in, absolute: the stored setting with its
 *  `~` expanded, else our own uploads folder. */
export function resolveUploadDirectory(setting: string): string {
  const stored = parseUploadDirectory(setting) ?? '';
  if (stored === '') return defaultUploadDirectory();
  const rest = underHome(stored);
  return rest === null ? path.normalize(stored) : path.join(os.homedir(), rest);
}

/** Names Windows reserves for devices, whatever their extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * The name a sent file is saved under: its own, minus any directory, with
 * every run of characters other than letters, digits, `.`, `_` and `-`
 * turned into one `-`. The same name on every OS: nothing Windows forbids
 * (`:`, `?`, a trailing dot, a device name like `NUL`), no name that can
 * climb out of the upload directory or hide itself with a leading dot.
 */
export function uploadFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const safe = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  if (safe === '') return UPLOAD_FALLBACK_FILE_NAME;
  if (WINDOWS_DEVICE_NAME.test(safe)) return `${UPLOAD_FALLBACK_FILE_NAME}-${safe}`;
  if (safe.length <= UPLOAD_FILE_NAME_MAX_LENGTH) return safe;
  const ext = path.extname(safe);
  // An "extension" as long as the limit is not one: cut the whole name.
  const kept = ext.length >= UPLOAD_FILE_NAME_MAX_LENGTH ? '' : ext;
  // The cut must not end on a dot or dash either.
  const stem = safe.slice(0, UPLOAD_FILE_NAME_MAX_LENGTH - kept.length).replace(/[.-]+$/, '');
  return stem + kept;
}

/**
 * A saved file's path as text for the terminal, the way each OS's own
 * terminal types a dropped file: on Windows in double quotes when it holds a
 * space (a path there can't hold a quote), elsewhere with a backslash before
 * every character a shell would read as more than itself. Our file names
 * never need it; the directory (a user's choice, a home folder with a space)
 * can.
 */
export function terminalPathText(filePath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return /\s/.test(filePath) ? `"${filePath}"` : filePath;
  return filePath.replace(/[^\p{L}\p{N}_\-./+:@%,=]/gu, '\\$&');
}

/** `photo.jpg` → `photo-2.jpg`: the nth name tried for a taken one. */
function numberedName(name: string, n: number): string {
  if (n === 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}-${String(n)}${ext}`;
}

/** The body went past the size limit (the route answers 413). */
export class UploadTooLargeError extends Error {
  constructor() {
    super('upload too large');
  }
}

/**
 * Save `body` in `directory` (created when missing) under `name`, or the
 * first numbered variant no file holds -- an existing file is never
 * overwritten (exclusive create). Resolves with the saved file's path. A
 * failed or oversized save leaves no partial file behind.
 */
export async function saveUpload(
  body: Readable,
  directory: string,
  name: string,
  maxBytes: number,
): Promise<string> {
  await fs.promises.mkdir(directory, { recursive: true });

  let handle: fs.promises.FileHandle | null = null;
  let filePath = '';
  for (let n = 1; n <= UPLOAD_NAME_ATTEMPTS && !handle; n++) {
    filePath = path.join(directory, numberedName(name, n));
    try {
      handle = await fs.promises.open(filePath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  if (!handle) throw new Error(`no free name for ${name} in ${directory}`);

  const out = handle.createWriteStream();
  try {
    // By hand rather than stream.pipeline: that destroys its source on a
    // failure, and the source is the request -- its socket would go with it,
    // before the route could answer that the file was too large.
    await new Promise<void>((resolve, reject) => {
      let received = 0;
      const onData = (chunk: Buffer): void => {
        received += chunk.length;
        if (received > maxBytes) {
          fail(new UploadTooLargeError());
        } else if (!out.write(chunk)) {
          body.pause();
          out.once('drain', () => body.resume());
        }
      };
      const fail = (err: Error): void => {
        body.off('data', onData);
        body.pause();
        reject(err);
      };
      body.on('data', onData);
      body.once('end', () => out.end());
      body.once('error', fail);
      // A request cut short ends without 'end'.
      body.once('close', () => {
        if (!body.readableEnded) fail(new Error('upload interrupted'));
      });
      out.once('error', fail);
      out.once('finish', resolve);
    });
  } catch (err) {
    // Closes the file handle too -- and waits for it: Windows won't delete a
    // file that is still open.
    if (!out.closed) {
      await new Promise<void>((resolve) => {
        out.once('close', resolve);
        out.destroy();
      });
    }
    await fs.promises.rm(filePath, { force: true });
    throw err;
  }
  return filePath;
}

export interface UploadSweepLimits {
  maxAgeMs: number;
  maxTotalBytes: number;
}

/**
 * Keep `directory` from growing: delete every file sent more than `maxAgeMs`
 * ago (a saved file's modification time is when it was sent), then, while
 * what is left weighs more than `maxTotalBytes`, the oldest first. Only plain
 * files straight under it -- nothing we save is anything else. `keep` (the
 * file just saved) is never deleted. Resolves with how many files went; a
 * folder that doesn't exist yet, or a file that won't go, is nothing to
 * report.
 */
export async function sweepUploads(
  directory: string,
  now: number,
  limits: UploadSweepLimits = {
    maxAgeMs: UPLOAD_MAX_AGE_MS,
    maxTotalBytes: UPLOADS_MAX_TOTAL_BYTES,
  },
  keep?: string,
): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch {
    return 0;
  }
  const files: Array<{ filePath: string; size: number; sentAt: number }> = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (stat.isFile()) files.push({ filePath, size: stat.size, sentAt: stat.mtimeMs });
    } catch {
      // Gone since it was listed.
    }
  }
  files.sort((a, b) => a.sentAt - b.sentAt);

  let total = files.reduce((sum, file) => sum + file.size, 0);
  let removed = 0;
  for (const file of files) {
    const expired = now - file.sentAt > limits.maxAgeMs;
    if ((!expired && total <= limits.maxTotalBytes) || file.filePath === keep) continue;
    try {
      await fs.promises.rm(file.filePath);
      total -= file.size;
      removed++;
    } catch {
      // Still open somewhere (Windows), or already gone: the next sweep's.
    }
  }
  return removed;
}

/** Sweep our own uploads folder now and every UPLOAD_SWEEP_INTERVAL_MS while
 *  the server runs. Returns the stop. */
export function startUploadSweeps(): () => void {
  const sweep = (): void => {
    void sweepUploads(defaultUploadDirectory(), Date.now()).then((removed) => {
      if (removed > 0) {
        console.log(`[Pixel Agents] Removed ${String(removed)} old file(s) sent to terminals`);
      }
    });
  };
  sweep();
  const timer = setInterval(sweep, UPLOAD_SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
