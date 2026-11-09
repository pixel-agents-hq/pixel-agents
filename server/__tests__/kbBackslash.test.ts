/**
 * P2 驗證 D1 的回歸測試：darwin、linux 上 `\` 是檔名中的普通字元，不是分隔字元。
 * 舊實作以 /[\\/]+/ 切段，把 `<root>/.note/x\..\..\y.md` 消成 `<root>/y.md` 而放行，
 * 實際寫入卻落在 `<root>/.note/` 底下。每個案例先以 fs 實際寫入，證明落點在受保護區內。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WRITE_GUARD_RULE_KB_PERSONAL as PERSONAL,
  WRITE_GUARD_RULE_KB_WORKSPACE_NO_WRITER as NO_WRITER,
} from '../src/constants.js';
import { extractGuardFields } from '../src/providers/hook/claude/guard/fieldExtraction.js';
import { planGuard } from '../src/providers/hook/claude/guard/hookGuard.js';
import type { ServerConfig } from '../src/serverConfig.js';
import {
  createPathNormalizer,
  normalizeTargetCandidates,
} from '../src/writeGuard/pathNormalization.js';
import { KbHarness } from './curatorHarness.js';
import { GuardProbe } from './kbRulesProbe.js';

/** `\` 只有在 POSIX 主機上才能真的成為檔名的一部分。 */
const posixHost = process.platform !== 'win32';
const POSIX_PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux'];

let h: KbHarness;
let ws: { id: string; dir: string };
let root: string;
let note: string;

beforeEach(() => {
  h = new KbHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ws = h.workspace('alpha');
  root = path.join(h.tempHome, 'alpha-root');
  note = path.join(root, '.note');
  fs.mkdirSync(note, { recursive: true });
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath: root })).toEqual([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  h.dispose();
});

/** 以 fs 原樣寫入，回傳實際落點所在目錄的內容，證明測試前提為真。 */
function landsIn(raw: string, dir: string): boolean {
  fs.writeFileSync(raw, 'x');
  const landed = fs.readdirSync(dir).includes(path.basename(raw));
  fs.rmSync(raw);
  return landed;
}

describe.runIf(posixHost)('backslash is an ordinary file name character on POSIX (D1)', () => {
  for (const platform of POSIX_PLATFORMS) {
    describe(`platform ${platform}`, () => {
      const normalizer = createPathNormalizer({ platform });

      it('repro 1: <root>/.note/x\\..\\..\\y.md is denied (it lands inside .note/)', async () => {
        const raw = `${note}/x\\..\\..\\y.md`;
        expect(landsIn(raw, note)).toBe(true);
        expect(normalizer.normalizeTarget(raw, '')).toBe(raw);
        expect(normalizeTargetCandidates(normalizer, raw, '')).toEqual([raw]);

        const probe = new GuardProbe(h, normalizer);
        try {
          const agent = await probe.launch(ws.dir);
          expect(probe.ask(agent, 'Write', raw)).toEqual({
            verdict: 'deny',
            rule: NO_WRITER,
            path: raw,
          });
          // 相對路徑版本也一樣。
          expect(probe.ask(agent, 'Edit', '.note/x\\..\\..\\y.md', root)).toMatchObject({
            rule: NO_WRITER,
          });
        } finally {
          probe.dispose();
        }
      });

      it("repro 2: <Dir>/.note/b.md/q\\..\\..\\a.md\\z is denied (it lands in another key's folder)", async () => {
        const bDir = path.join(ws.dir, '.note', 'b.md');
        fs.mkdirSync(bDir, { recursive: true });
        const raw = `${bDir}/q\\..\\..\\a.md\\z`;
        expect(landsIn(raw, bDir)).toBe(true);

        const probe = new GuardProbe(h, normalizer);
        try {
          const mine = await probe.launch(ws.dir, 'a.md');
          await probe.launch(ws.dir, 'b.md');
          expect(probe.ask(mine, 'Write', raw)).toEqual({
            verdict: 'deny',
            rule: PERSONAL,
            path: raw,
          });
        } finally {
          probe.dispose();
        }
      });

      it('the hook-local fallback (server unreachable) also treats it as protected', () => {
        const server: ServerConfig = {
          port: 4200,
          pid: process.pid,
          token: 't',
          startedAt: 0,
          servesSpa: true,
          protocol: 1,
          standalone: { terminal: true, host: '127.0.0.1', allowedHosts: [] },
        };
        const plan = planGuard(
          {
            hook_event_name: 'PreToolUse',
            session_id: 's',
            cwd: root,
            tool_name: 'Write',
            tool_input: { file_path: `${note}/x\\..\\..\\y.md` },
          },
          [server],
          {
            extractFields: extractGuardFields,
            normalizer,
            readList: () => ({
              version: 1,
              pid: server.pid,
              port: server.port,
              protectedRoots: [note],
              knownSessions: ['s'],
            }),
          },
        );
        expect(plan?.targets[0].protectedHit).toBe(true);
        expect(plan?.fallback.decision).toBe('deny');
      });

      it('a backslash file name without `..` is one name: denied in the KB, allowed under the own key', async () => {
        const inKb = `${note}/a\\b.md`;
        expect(landsIn(inKb, note)).toBe(true);
        const ownDir = path.join(ws.dir, '.note', 'a.md');
        fs.mkdirSync(ownDir, { recursive: true });
        const own = `${ownDir}/c\\d.md`;
        expect(landsIn(own, ownDir)).toBe(true);

        const probe = new GuardProbe(h, normalizer);
        try {
          const mine = await probe.launch(ws.dir, 'a.md');
          expect(probe.ask(mine, 'Write', inKb)).toMatchObject({
            verdict: 'deny',
            rule: NO_WRITER,
          });
          expect(probe.ask(mine, 'Write', own)).toEqual({ verdict: 'allow' });
        } finally {
          probe.dispose();
        }
      });
    });
  }
});

describe('win32 still treats backslash as a separator (behaviour unchanged)', () => {
  const win32 = createPathNormalizer({ platform: 'win32' });

  it('x\\..\\..\\y.md climbs out of .note/ on win32', () => {
    expect(win32.normalizeTarget('C:\\ws\\.note\\x\\..\\..\\y.md', '')).toBe('C:\\ws\\y.md');
    expect(win32.isWithin('C:\\ws\\y.md', 'C:\\ws\\.note')).toBe(false);
    expect(win32.isWithin('C:\\WS\\.NOTE\\a/b.md', 'c:\\ws\\.note')).toBe(true);
    expect(normalizeTargetCandidates(win32, 'C:\\ws\\.note\\x\\..\\..\\y.md', '')).toEqual([
      'C:\\ws\\y.md',
    ]);
    expect(normalizeTargetCandidates(win32, '.note\\a.md', 'C:\\ws')).toEqual([
      'C:\\ws\\.note\\a.md',
    ]);
  });
});
