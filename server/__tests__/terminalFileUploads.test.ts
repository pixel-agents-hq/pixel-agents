/**
 * Files sent to a terminal: the upload route's gate (it writes onto the
 * operator's machine, so it is as closed as the terminal socket), what it
 * saves, and the per-OS rules for the folder, the name and the pasted path.
 */

import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  downloadsDirectory,
  parseUploadDirectory,
  resolveUploadDirectory,
  sweepUploads,
  terminalPathText,
  uploadFileName,
  xdgDownloadDirectory,
} from '../src/terminal/fileUploads.js';
import { registerTerminalRoutes } from '../src/terminal/terminalRoutes.js';
import type { TerminalSessions } from '../src/terminal/terminalSessions.js';
import { removeTempDir } from './helpers/removeTempDir.js';

const TOKEN = 'test-token';
const MAX_BYTES = 32;

describe('terminal file upload route', () => {
  let app: FastifyInstance;
  let dir: string;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-upload-test-'));
    app = Fastify();
    // Only agent 1 has a terminal.
    const ptyManager = { has: (id: number) => id === 1 } as unknown as TerminalSessions;
    registerTerminalRoutes(app, {
      token: TOKEN,
      allowedHostnames: new Set(['127.0.0.1', 'localhost', 'office.example']),
      ptyManager,
      uploadDirectory: () => path.join(dir, 'inbox'),
      maxUploadBytes: MAX_BYTES,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    base = `http://127.0.0.1:${String(typeof address === 'object' ? address?.port : 0)}`;
  });

  afterEach(async () => {
    await app.close();
    removeTempDir(dir);
  });

  function upload(
    body: string,
    opts: { agentId?: number; name?: string; token?: string | null; origin?: string } = {},
  ): Promise<Response> {
    const query = new URLSearchParams({ name: opts.name ?? 'notes.txt' });
    if (opts.token !== null) query.set('token', opts.token ?? TOKEN);
    return fetch(`${base}/api/terminal/${String(opts.agentId ?? 1)}/files?${query.toString()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
      body,
    });
  }

  const saved = () =>
    fs.existsSync(path.join(dir, 'inbox')) ? fs.readdirSync(path.join(dir, 'inbox')) : [];

  it('saves the file in the upload directory (created on demand) and answers its path', async () => {
    const res = await upload('hello', { name: 'my notes.txt' });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { path: string; text: string };
    expect(answer.path).toBe(path.join(dir, 'inbox', 'my-notes.txt'));
    expect(answer.text).toBe(terminalPathText(answer.path, process.platform));
    expect(fs.readFileSync(answer.path, 'utf-8')).toBe('hello');
  });

  it('never overwrites: a taken name gets a number', async () => {
    const first = (await (await upload('one')).json()) as { path: string };
    const second = (await (await upload('two')).json()) as { path: string };
    expect(path.basename(second.path)).toBe('notes-2.txt');
    expect(fs.readFileSync(first.path, 'utf-8')).toBe('one');
    expect(fs.readFileSync(second.path, 'utf-8')).toBe('two');
  });

  it('keeps a name that tries to climb out inside the upload directory', async () => {
    const res = await upload('x', { name: '../../escape.txt' });
    const answer = (await res.json()) as { path: string };
    expect(answer.path).toBe(path.join(dir, 'inbox', 'escape.txt'));
  });

  it('refuses an upload with no token or a wrong one, saving nothing', async () => {
    expect((await upload('x', { token: null })).status).toBe(401);
    expect((await upload('x', { token: 'not-the-token' })).status).toBe(401);
    expect(saved()).toEqual([]);
  });

  it('refuses a tokened upload from a foreign origin', async () => {
    expect((await upload('x', { origin: 'http://evil.com' })).status).toBe(403);
    expect(saved()).toEqual([]);
  });

  it('refuses a tokened upload under a Host that is not allowed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/terminal/1/files?name=a.txt&token=${TOKEN}`,
      headers: { host: 'evil.com', 'content-type': 'application/octet-stream' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(403);
    expect(saved()).toEqual([]);
  });

  it('refuses an agent with no terminal', async () => {
    expect((await upload('x', { agentId: 2 })).status).toBe(404);
    expect(saved()).toEqual([]);
  });

  it('refuses a file past the size limit and leaves no partial file', async () => {
    expect((await upload('x'.repeat(MAX_BYTES + 1))).status).toBe(413);
    expect(saved()).toEqual([]);
  });

  it('counts the bytes itself when the size is not declared up front', async () => {
    // A chunked body carries no Content-Length for the early check to read.
    const chunks = (async function* () {
      yield Buffer.from('x'.repeat(MAX_BYTES));
      yield Buffer.from('y');
    })();
    const res = await app.inject({
      method: 'POST',
      url: `/api/terminal/1/files?name=big.bin&token=${TOKEN}`,
      headers: { host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: (await import('stream')).Readable.from(chunks),
    });
    expect(res.statusCode).toBe(413);
    expect(saved()).toEqual([]);
  });
});

describe('a file already on this machine', () => {
  let app: FastifyInstance;
  let dir: string;
  let original: string;
  let identity: { name: string; size: number; lastModified: number };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-locate-test-'));
    original = path.join(dir, 'report final.pdf');
    fs.writeFileSync(original, 'the original');
    const stat = fs.statSync(original);
    // What a browser reports for it: whole milliseconds.
    identity = {
      name: 'report final.pdf',
      size: stat.size,
      lastModified: Math.floor(stat.mtimeMs),
    };
    app = Fastify();
    registerTerminalRoutes(app, {
      token: TOKEN,
      allowedHostnames: new Set(['127.0.0.1', 'localhost', 'office.example']),
      ptyManager: { has: (id: number) => id === 1 } as unknown as TerminalSessions,
      // The folder the file sits in is one of those looked in.
      uploadDirectory: () => dir,
      // A Directory the user added, holding a file of its own.
      sourceDirectories: () => [path.join(dir, 'project')],
    });
    fs.mkdirSync(path.join(dir, 'project', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'project', 'README.md'), 'at the root');
    fs.writeFileSync(path.join(dir, 'project', 'src', 'deep.ts'), 'deeper');
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    removeTempDir(dir);
  });

  const locate = (body: unknown, opts: { host?: string; token?: string } = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/terminal/1/files/locate?token=${opts.token ?? TOKEN}`,
      headers: { host: opts.host ?? 'localhost:3100', 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  it("answers the file's own path, and makes no copy", async () => {
    const res = await locate(identity);
    expect(res.statusCode).toBe(200);
    const answer = res.json<{ path: string; text: string }>();
    expect(answer.path).toBe(original);
    expect(answer.text).toBe(terminalPathText(original, process.platform));
    expect(fs.readdirSync(dir).sort()).toEqual(['project', 'report final.pdf']);
  });

  it('finds a file straight under a Directory the user added, but looks no deeper', async () => {
    const identityOf = (filePath: string) => {
      const stat = fs.statSync(filePath);
      return {
        name: path.basename(filePath),
        size: stat.size,
        lastModified: Math.floor(stat.mtimeMs),
      };
    };
    const readme = path.join(dir, 'project', 'README.md');
    const res = await locate(identityOf(readme));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ path: string }>().path).toBe(readme);
    const deep = await locate(identityOf(path.join(dir, 'project', 'src', 'deep.ts')));
    expect(deep.statusCode).toBe(404);
  });

  it('does not take a same-named file of another size or another time for it', async () => {
    expect((await locate({ ...identity, size: identity.size + 1 })).statusCode).toBe(404);
    expect(
      (await locate({ ...identity, lastModified: identity.lastModified - 60_000 })).statusCode,
    ).toBe(404);
  });

  it("never looks when the browser is not on this machine (a proxy's Host)", async () => {
    expect((await locate(identity, { host: 'office.example' })).statusCode).toBe(404);
  });

  it('refuses a name that is a path, and a body that describes no file', async () => {
    expect(
      (await locate({ ...identity, name: `../${path.basename(dir)}/report final.pdf` })).statusCode,
    ).toBe(404);
    expect((await locate({ name: 'report final.pdf' })).statusCode).toBe(404);
  });

  it('is behind the same token as the upload', async () => {
    expect((await locate(identity, { token: 'not-the-token' })).statusCode).toBe(401);
  });
});

describe('uploadFileName', () => {
  it('keeps letters of any script, digits, dots, dashes and underscores', () => {
    expect(uploadFileName('informe_año-2026.final.pdf')).toBe('informe_año-2026.final.pdf');
  });

  it('turns everything else into single dashes', () => {
    expect(uploadFileName('Screenshot 2026-11-10 at 10.30.15 (1).png')).toBe(
      'Screenshot-2026-11-10-at-10.30.15-1-.png',
    );
    expect(uploadFileName('what?:*<>|".txt')).toBe('what-.txt');
  });

  it('drops directories, either separator', () => {
    expect(uploadFileName('/etc/passwd')).toBe('passwd');
    expect(uploadFileName('C:\\Users\\me\\photo.jpg')).toBe('photo.jpg');
  });

  it('never yields a hidden file, a trailing dot, or an empty name', () => {
    expect(uploadFileName('.env')).toBe('env');
    expect(uploadFileName('..')).toBe('file');
    expect(uploadFileName('name.')).toBe('name');
    expect(uploadFileName('')).toBe('file');
  });

  it('steers clear of the names Windows reserves for devices', () => {
    expect(uploadFileName('NUL')).toBe('file-NUL');
    expect(uploadFileName('com1.txt')).toBe('file-com1.txt');
    expect(uploadFileName('console.txt')).toBe('console.txt');
  });

  it('cuts a long name but keeps its extension', () => {
    const name = uploadFileName(`${'a'.repeat(300)}.jpeg`);
    expect(name).toHaveLength(120);
    expect(name.endsWith('.jpeg')).toBe(true);
  });
});

describe('terminalPathText', () => {
  it('leaves a plain path alone on every OS', () => {
    expect(terminalPathText('/home/me/Downloads/a-1.png', 'linux')).toBe(
      '/home/me/Downloads/a-1.png',
    );
    expect(terminalPathText('C:\\Users\\me\\Downloads\\a-1.png', 'win32')).toBe(
      'C:\\Users\\me\\Downloads\\a-1.png',
    );
  });

  it('backslash-escapes what a POSIX shell would split or expand', () => {
    expect(terminalPathText("/Users/me/My Files (old)/it's $x.png", 'darwin')).toBe(
      "/Users/me/My\\ Files\\ \\(old\\)/it\\'s\\ \\$x.png",
    );
  });

  it('quotes a Windows path holding a space, backslashes untouched', () => {
    expect(terminalPathText('C:\\Users\\Ana Maria\\Downloads\\a.png', 'win32')).toBe(
      '"C:\\Users\\Ana Maria\\Downloads\\a.png"',
    );
  });
});

describe('upload directory', () => {
  it('stores an absolute path or one under ~, and refuses a relative one', () => {
    expect(parseUploadDirectory('  /srv/inbox  ')).toBe('/srv/inbox');
    expect(parseUploadDirectory('~/Desktop')).toBe('~/Desktop');
    expect(parseUploadDirectory('')).toBe('');
    expect(parseUploadDirectory('inbox')).toBeNull();
    expect(parseUploadDirectory('~other/inbox')).toBeNull();
    expect(parseUploadDirectory(7)).toBeNull();
  });

  it('resolves ~ against the home directory', () => {
    expect(resolveUploadDirectory('~/Desktop/in')).toBe(path.join(os.homedir(), 'Desktop', 'in'));
    expect(resolveUploadDirectory('~')).toBe(os.homedir());
  });

  it('defaults to a folder of our own, not the Downloads folder', () => {
    expect(resolveUploadDirectory('')).toBe(path.join(os.homedir(), '.pixel-agents', 'uploads'));
    // The isolated test HOME has no user-dirs.dirs, so Linux agrees.
    expect(downloadsDirectory()).toBe(path.join(os.homedir(), 'Downloads'));
  });

  it("reads Linux's Downloads folder from user-dirs.dirs", () => {
    const userDirs = [
      '# This file is written by xdg-user-dirs-update',
      'XDG_DESKTOP_DIR="$HOME/Escritorio"',
      'XDG_DOWNLOAD_DIR="$HOME/Descargas"',
    ].join('\n');
    expect(xdgDownloadDirectory(userDirs, '/home/ana')).toBe(path.join('/home/ana', 'Descargas'));
    expect(xdgDownloadDirectory('XDG_DOWNLOAD_DIR="/mnt/data/dl"', '/home/ana')).toBe(
      path.normalize('/mnt/data/dl'),
    );
  });

  it('ignores a user-dirs.dirs that names no Downloads folder', () => {
    expect(xdgDownloadDirectory('XDG_DESKTOP_DIR="$HOME/Desktop"', '/home/ana')).toBeNull();
    // How xdg-user-dirs writes "there is none".
    expect(xdgDownloadDirectory('XDG_DOWNLOAD_DIR="$HOME/"', '/home/ana')).toBeNull();
    expect(xdgDownloadDirectory('XDG_DOWNLOAD_DIR="relative/dir"', '/home/ana')).toBeNull();
  });
});

describe('sweeping our own uploads folder', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 11);
  const limits = { maxAgeMs: 7 * DAY, maxTotalBytes: 100 };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-sweep-test-'));
  });
  afterEach(() => removeTempDir(dir));

  /** A file of `size` bytes sent `daysAgo` days before NOW. */
  const sent = (name: string, daysAgo: number, size = 1): string => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, 'x'.repeat(size));
    const when = new Date(NOW - daysAgo * DAY);
    fs.utimesSync(filePath, when, when);
    return filePath;
  };
  const left = (): string[] => fs.readdirSync(dir).sort();

  it('deletes files sent longer ago than the limit, and only those', async () => {
    sent('old.png', 8);
    sent('week.png', 6.9);
    sent('new.png', 0);
    expect(await sweepUploads(dir, NOW, limits)).toBe(1);
    expect(left()).toEqual(['new.png', 'week.png']);
  });

  it('past the size limit the oldest go first, until it fits', async () => {
    sent('a.bin', 3, 60);
    sent('b.bin', 2, 60);
    sent('c.bin', 1, 30);
    expect(await sweepUploads(dir, NOW, limits)).toBe(1);
    expect(left()).toEqual(['b.bin', 'c.bin']);
  });

  it('never deletes the file just saved, nor anything that is not a plain file', async () => {
    const kept = sent('huge.bin', 0, 500);
    fs.mkdirSync(path.join(dir, 'folder'));
    sent('other.bin', 1, 10);
    await sweepUploads(dir, NOW, limits, kept);
    expect(left()).toEqual(['folder', 'huge.bin']);
  });

  it('a folder that does not exist yet is nothing to sweep', async () => {
    expect(await sweepUploads(path.join(dir, 'nope'), NOW, limits)).toBe(0);
  });
});
