/**
 * P2 路徑正規化（F8）與欄位抽取（F7）。以臨時目錄建立真實 symlink，不呼叫真實 claude。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractGuardFields,
  isFileWriteTool,
} from '../src/providers/hook/claude/guard/fieldExtraction.js';
import { planGuard } from '../src/providers/hook/claude/guard/hookGuard.js';
import type { ServerConfig } from '../src/serverConfig.js';
import {
  createPathNormalizer,
  normalizeTargetCandidates,
  pathNormalizer,
  samePath,
} from '../src/writeGuard/pathNormalization.js';

let base: string;
let ws: string;
let note: string;
let elsewhere: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kb-path-')));
  ws = path.join(base, 'ws');
  note = path.join(ws, '.note');
  elsewhere = path.join(base, 'elsewhere', 'deep');
  fs.mkdirSync(note, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const within = (p: string | null, root: string) => p !== null && pathNormalizer.isWithin(p, root);

describe('normalizeTarget (OS semantics, F8)', () => {
  it('a/link/../b resolves the link before `..` (link pointing into the protected area)', () => {
    // ws/src/link -> ws/.note/sub ；字面消去會得到 ws/src/b，作業系統語意是 ws/.note/b。
    fs.mkdirSync(path.join(note, 'sub'));
    fs.mkdirSync(path.join(ws, 'src'));
    fs.symlinkSync(path.join(note, 'sub'), path.join(ws, 'src', 'link'));
    const raw = `${ws}/src/link/../b.md`;
    expect(pathNormalizer.normalizeTarget(raw, '')).toBe(path.join(note, 'b.md'));
    // 字面候選也一併保留（寫入工具可能用字面語意）。
    expect(normalizeTargetCandidates(pathNormalizer, raw, '')).toEqual([
      path.join(note, 'b.md'),
      path.join(ws, 'src', 'b.md'),
    ]);
  });

  it('keeps the lexical candidate when it is the protected one', () => {
    // ws/link -> elsewhere/deep ；作業系統語意是 elsewhere/.note，字面語意是 ws/.note。
    fs.symlinkSync(elsewhere, path.join(ws, 'link'));
    const candidates = normalizeTargetCandidates(pathNormalizer, `${ws}/link/../.note/a.md`, '');
    expect(candidates).toContain(path.join(note, 'a.md'));
    expect(candidates?.some((c) => within(c, note))).toBe(true);
  });

  it('follows a dangling symlink in the last segment to its (protected) target', () => {
    fs.symlinkSync(path.join(note, 'new.md'), path.join(ws, 'innocent.md'));
    expect(pathNormalizer.normalizeTarget(path.join(ws, 'innocent.md'), '')).toBe(
      path.join(note, 'new.md'),
    );
  });

  it('follows a relative symlink target and a symlinked directory', () => {
    fs.symlinkSync('.note', path.join(ws, 'notes'));
    expect(pathNormalizer.normalizeTarget('notes/x/y.md', ws)).toBe(path.join(note, 'x', 'y.md'));
  });

  it('realpaths the deepest existing parent of a new file and appends the rest', () => {
    expect(pathNormalizer.normalizeTarget(path.join(note, 'a', 'b', 'new.md'), '')).toBe(
      path.join(note, 'a', 'b', 'new.md'),
    );
  });

  it('a `..` below a missing directory climbs back lexically', () => {
    expect(pathNormalizer.normalizeTarget(`${ws}/missing/../.note/a.md`, '')).toBe(
      path.join(note, 'a.md'),
    );
  });

  it('resolves the /private prefix of the macOS temp directories', () => {
    if (process.platform !== 'darwin') return;
    const viaTmp = path.join('/tmp', `pxl-kb-private-${process.pid}`);
    fs.mkdirSync(viaTmp, { recursive: true });
    try {
      expect(pathNormalizer.normalizeTarget(path.join(viaTmp, 'a.md'), '')).toBe(
        path.join('/private', viaTmp, 'a.md'),
      );
    } finally {
      fs.rmSync(viaTmp, { recursive: true, force: true });
    }
  });

  it('fails closed (null) for a symlink loop', () => {
    fs.symlinkSync(path.join(ws, 'loop-b'), path.join(ws, 'loop-a'));
    fs.symlinkSync(path.join(ws, 'loop-a'), path.join(ws, 'loop-b'));
    expect(pathNormalizer.normalizeTarget(path.join(ws, 'loop-a', 'x'), '')).toBeNull();
  });

  it('fails closed (null) for a relative path with an empty or relative cwd', () => {
    expect(pathNormalizer.normalizeTarget('.note/a.md', '')).toBeNull();
    expect(pathNormalizer.normalizeTarget('.note/a.md', 'ws')).toBeNull();
    expect(pathNormalizer.normalizeTarget('', ws)).toBeNull();
    expect(pathNormalizer.normalizeTarget('a\0b', ws)).toBeNull();
    expect(normalizeTargetCandidates(pathNormalizer, '../.note/a.md', 'rel')).toBeNull();
  });
});

describe('isWithin case folding (F8)', () => {
  it('darwin and win32 fold case; linux does not', () => {
    const darwin = createPathNormalizer({ platform: 'darwin' });
    const win32 = createPathNormalizer({ platform: 'win32' });
    const linux = createPathNormalizer({ platform: 'linux' });
    expect(darwin.isWithin('/W/.NOTE/a.md', '/w/.note')).toBe(true);
    expect(win32.isWithin('/W/.NOTE/a.md', '/w/.note')).toBe(true);
    expect(linux.isWithin('/W/.NOTE/a.md', '/w/.note')).toBe(false);
    expect(samePath(darwin, '/a/B', '/A/b')).toBe(true);
  });

  it('darwin also treats NFC and NFD spellings as one', () => {
    const darwin = createPathNormalizer({ platform: 'darwin' });
    expect(darwin.isWithin('/café/.note/a', '/café/.note')).toBe(true);
  });

  it('macOS: `.NOTE/a.md` on the real (case-insensitive) volume is inside `.note`', () => {
    if (process.platform !== 'darwin') return;
    const upper = pathNormalizer.normalizeTarget(path.join(ws, '.NOTE', 'a.md'), '');
    expect(within(upper, note)).toBe(true);
  });
});

describe('field extraction for write tools (F7)', () => {
  const payload = (tool: string, input: Record<string, unknown>) => ({
    hook_event_name: 'PreToolUse',
    session_id: 's',
    cwd: ws,
    tool_name: tool,
    tool_input: input,
  });

  it('extracts NotebookEdit notebook_path (and file_path when present)', () => {
    expect(extractGuardFields(payload('NotebookEdit', { notebook_path: '/n.ipynb' }))).toEqual({
      toolName: 'NotebookEdit',
      sessionId: 's',
      cwd: ws,
      pathFields: ['/n.ipynb'],
    });
    expect(
      extractGuardFields(payload('NotebookEdit', { notebook_path: '/n', file_path: '/f' }))
        ?.pathFields,
    ).toEqual(['/n', '/f']);
    expect(isFileWriteTool('NotebookEdit')).toBe(true);
    expect(isFileWriteTool('Bash')).toBe(false);
  });

  const server: ServerConfig = {
    port: 4999,
    pid: process.pid,
    token: 't',
    startedAt: 0,
    servesSpa: true,
    protocol: 1,
    standalone: { terminal: true, host: '127.0.0.1' },
  };
  const plan = (p: Record<string, unknown>, roots: string[]) =>
    planGuard(p, [server], {
      extractFields: extractGuardFields,
      normalizer: pathNormalizer,
      readList: () => ({
        version: 1,
        pid: server.pid,
        port: 4999,
        protectedRoots: roots,
        knownSessions: ['s'],
      }),
    });

  it('marks a Write without file_path, and an unresolvable path, as unresolved', () => {
    for (const p of [
      payload('Write', { content: 'x' }),
      payload('NotebookEdit', { new_source: 'x' }),
      { ...payload('Edit', { file_path: 'rel.md' }), cwd: '' },
    ]) {
      const result = plan(p, [note]);
      expect(result?.request.unresolved).toBe(true);
      expect(result?.request.paths).toEqual([]);
      // 伺服器不可達時：有受保護根目錄就 fail-closed。
      expect(result?.fallback.decision).toBe('deny');
      expect(plan(p, [])?.fallback.decision).toBe('allow');
    }
  });

  it('does not mark Bash (P3) or a resolvable Write as unresolved', () => {
    expect(plan(payload('Bash', { command: 'ls' }), [note])?.request.unresolved).toBeUndefined();
    expect(
      plan(payload('Write', { file_path: path.join(ws, 'a.md') }), [note])?.request.unresolved,
    ).toBeUndefined();
  });
});
