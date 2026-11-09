/**
 * P2 KB 寫入阻擋（檔案工具）的整合測試：真的 store、runtime、launcher（假 PTY）、
 * curator 表與 WriteGuard，請求經過真的 hook 端欄位抽取與路徑正規化（planGuard）。
 * 臨時 HOME；不呼叫真實 claude、不發任何 capability。驗收 1、2、4、5、7、8。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KB_PERSONAL_RESERVED_KEY,
  WRITE_GUARD_DENY_TEMPLATES,
  WRITE_GUARD_RULE_KB_PATH_UNRESOLVED as UNRESOLVED,
  WRITE_GUARD_RULE_KB_PERSONAL as PERSONAL,
  WRITE_GUARD_RULE_KB_WORKSPACE as WORKSPACE,
  WRITE_GUARD_RULE_KB_WORKSPACE_NO_WRITER as NO_WRITER,
} from '../src/constants.js';
import { renderDenyMessage } from '../src/writeGuard/denyMessage.js';
import { KbHarness } from './curatorHarness.js';
import { GuardProbe } from './kbRulesProbe.js';

let h: KbHarness;
let probe: GuardProbe;
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
  probe = new GuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

const setRoot = (rootPath: string | null, workspaceId = ws.id) =>
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId, rootPath })).toEqual([]);
const appoint = (agentId: number, workspaceId = ws.id) =>
  expect(h.send({ type: 'setWorkspaceCurator', workspaceId, agentId })).toEqual([]);

describe('workspace KB (<root>/.note/)', () => {
  it('non-curators are denied Write, Edit and NotebookEdit; the curator is allowed', async () => {
    setRoot(root);
    const curator = await probe.launch(ws.dir);
    const other = await probe.launch(ws.dir);
    appoint(curator);
    const target = path.join(note, 'topic', 'a.md');
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      expect(probe.ask(other, tool, target)).toMatchObject({ verdict: 'deny', rule: WORKSPACE });
      expect(probe.ask(curator, tool, target)).toEqual({ verdict: 'allow' });
    }
    // 另一個工作空間的 Agent 也一律 deny。
    const beta = h.workspace('beta');
    const stranger = await probe.launch(beta.dir);
    expect(probe.ask(stranger, 'Write', target)).toMatchObject({ rule: WORKSPACE });
  });

  it('root set, no curator: every known agent is denied, suggesting a KB Writer', async () => {
    setRoot(root);
    const agent = await probe.launch(ws.dir);
    const verdict = probe.ask(agent, 'Write', path.join(note, 'a.md'));
    expect(verdict).toMatchObject({ verdict: 'deny', rule: NO_WRITER });
    const message = renderDenyMessage(NO_WRITER, undefined, []);
    expect(message).toContain('assign a KB Writer');
    expect(WRITE_GUARD_DENY_TEMPLATES[NO_WRITER].suggestion).toContain('KB Writer');
  });

  it('root not set: KB rules and F17 are off, exactly as before', async () => {
    const agent = await probe.launch(ws.dir);
    const other = await probe.launch(ws.dir, 'b.md');
    for (const target of [
      path.join(note, 'a.md'),
      path.join(ws.dir, '.note', 'b.md', 'x.md'),
      path.join(ws.dir, '.note', 'loose.md'),
      path.join(h.tempHome, '.pixel-agents', 'config.json'),
      path.join(h.tempHome, '.claude', 'settings.json'),
      path.join(ws.dir, '.claude', 'roles', 'x.md'),
    ]) {
      expect(probe.ask(agent, 'Write', target)).toEqual({ verdict: 'allow' });
    }
    expect(probe.ask(agent, 'Write', undefined)).toEqual({ verdict: 'allow' });
    expect(probe.ask(other, 'Edit', path.join(note, 'a.md'))).toEqual({ verdict: 'allow' });
    expect(probe.guard.getProtectedRoots()).toEqual([]);
  });

  it('publishes both KB areas, realpath-resolved, as the hook fail-closed roots', async () => {
    const link = path.join(h.tempHome, 'root-link');
    fs.symlinkSync(root, link);
    setRoot(link);
    await probe.launch(ws.dir);
    expect(probe.guard.getProtectedRoots()).toEqual([note, path.join(ws.dir, '.note')]);
    setRoot(null);
    expect(probe.guard.getProtectedRoots()).toEqual([]);
  });
});

describe('personal KB (<Agent Directory>/.note/)', () => {
  it('allows only under the own key; other, unused and loose paths are denied', async () => {
    setRoot(root);
    const mine = await probe.launch(ws.dir, 'a.md');
    await probe.launch(ws.dir, 'b.md');
    const personal = path.join(ws.dir, '.note');
    expect(probe.ask(mine, 'Write', path.join(personal, 'a.md', 'deep', 'x.md'))).toEqual({
      verdict: 'allow',
    });
    // 其他識別鍵（有人使用）、無人使用的識別鍵、不屬於任何識別鍵的檔案。
    for (const target of [
      path.join(personal, 'b.md', 'x.md'),
      path.join(personal, 'nobody.md', 'x.md'),
      path.join(personal, 'loose.md'),
      personal,
    ]) {
      expect(probe.ask(mine, 'Write', target)).toMatchObject({ verdict: 'deny', rule: PERSONAL });
    }
  });

  it('an agent without a Role writes only under the reserved key', async () => {
    setRoot(root);
    const plain = await probe.launch(ws.dir);
    const personal = path.join(ws.dir, '.note');
    expect(probe.ask(plain, 'Write', path.join(personal, KB_PERSONAL_RESERVED_KEY, 'x'))).toEqual({
      verdict: 'allow',
    });
    expect(probe.ask(plain, 'Write', path.join(personal, 'a.md', 'x'))).toMatchObject({
      rule: PERSONAL,
    });
  });

  it('ownership follows the Agent Directory, not the payload cwd (after a cd)', async () => {
    setRoot(root);
    const other = h.workspace('beta');
    const betaRoot = path.join(h.tempHome, 'beta-root');
    fs.mkdirSync(betaRoot);
    setRoot(betaRoot, other.id);
    const mine = await probe.launch(ws.dir, 'a.md');
    await probe.launch(other.dir, 'a.md');
    // 模擬 Bash cd 到另一個 Directory 後，以相對路徑寫「自己的」識別鍵。
    expect(probe.ask(mine, 'Write', '.note/a.md/x.md', other.dir)).toMatchObject({
      verdict: 'deny',
      rule: PERSONAL,
    });
    // 從別處以相對路徑寫回自己的 Directory：照樣以 Agent Directory 判斷而放行。
    expect(probe.ask(mine, 'Write', '../alpha/.note/a.md/x.md', other.dir)).toEqual({
      verdict: 'allow',
    });
  });

  it('a personal KB inside the workspace KB: the workspace rule wins', async () => {
    setRoot(root);
    const nested = path.join(note, 'agent-dir');
    fs.mkdirSync(nested, { recursive: true });
    const agent = await probe.launch(nested, 'a.md');
    expect(probe.ask(agent, 'Write', path.join(nested, '.note', 'a.md', 'x'))).toMatchObject({
      rule: NO_WRITER,
    });
  });
});

describe('path normalization through the rule (F7, F8)', () => {
  it('denies writes that reach a KB area through symlinks, `..`, dangling links and new dirs', async () => {
    setRoot(root);
    const agent = await probe.launch(ws.dir);
    fs.mkdirSync(path.join(ws.dir, 'src'), { recursive: true });
    fs.symlinkSync(note, path.join(ws.dir, 'src', 'notes'));
    fs.symlinkSync(path.join(note, 'sub'), path.join(ws.dir, 'src', 'into'));
    fs.symlinkSync(path.join(note, 'new.md'), path.join(ws.dir, 'src', 'dangling.md'));
    for (const raw of [
      path.join(ws.dir, 'src', 'notes', 'x.md'),
      `${ws.dir}/src/into/../y.md`,
      path.join(ws.dir, 'src', 'dangling.md'),
      path.join(note, 'brand', 'new', 'dir', 'z.md'),
      `${ws.dir}/../alpha-root/.note/w.md`,
    ]) {
      expect(probe.ask(agent, 'Write', raw), raw).toMatchObject({ verdict: 'deny' });
    }
    if (process.platform === 'darwin') {
      expect(probe.ask(agent, 'Write', path.join(root, '.NOTE', 'a.md'))).toMatchObject({
        rule: NO_WRITER,
      });
    }
  });

  it('denies a write tool whose path is missing or unresolvable while rules are on', async () => {
    setRoot(root);
    const agent = await probe.launch(ws.dir);
    expect(probe.ask(agent, 'Write', undefined)).toEqual({ verdict: 'deny', rule: UNRESOLVED });
    expect(probe.ask(agent, 'NotebookEdit', undefined)).toMatchObject({ rule: UNRESOLVED });
    expect(probe.ask(agent, 'Edit', 'rel.md', '')).toMatchObject({ rule: UNRESOLVED });
    expect(probe.ask(agent, 'Edit', 'rel.md', 'relative/cwd')).toMatchObject({ rule: UNRESOLVED });
    // NotebookEdit 的 notebook_path 被抽到並判斷。
    expect(probe.ask(agent, 'NotebookEdit', path.join(note, 'n.ipynb'))).toMatchObject({
      rule: NO_WRITER,
    });
    expect(probe.ask(agent, 'Write', path.join(ws.dir, 'src', 'ok.ts'))).toEqual({
      verdict: 'allow',
    });
  });
});
