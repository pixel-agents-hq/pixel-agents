/**
 * P3 第二次驗證 P2-4：工作空間根目錄含空白、引號、反斜線（POSIX）、Unicode 時，字面路徑
 * 仍被「子字串包含」掃描抓到；F17 的 HOME 含空白；以及 P2-2、P2-7 的純函式單元測試。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  WRITE_GUARD_RULE_BASH_UNRESOLVED as UNRESOLVED,
  WRITE_GUARD_RULE_KB_WORKSPACE as WORKSPACE,
  WRITE_GUARD_RULE_PROTECTED_CONFIG as CONFIG,
} from '../src/constants.js';
import { analyzeBash } from '../src/writeGuard/bashAnalysis.js';
import { decodeAnsiC } from '../src/writeGuard/bashAnsi.js';
import { commandName } from '../src/writeGuard/bashClassify.js';
import { WriteGuard } from '../src/writeGuard/writeGuard.js';
import { BashGuardProbe } from './bashGuardProbe.js';
import { KbHarness } from './curatorHarness.js';

let h: KbHarness | undefined;
let probe: BashGuardProbe | undefined;

afterEach(() => {
  probe?.dispose();
  vi.restoreAllMocks();
  h?.dispose();
  h = undefined;
  probe = undefined;
});

/** 以 rootName 為根目錄名稱建立工作空間（含 curator 與一個非 curator），回傳 note 與非 curator。 */
function setup(rootName: string) {
  h = new KbHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const ws = h.workspace('alpha');
  const root = path.join(h.tempHome, rootName);
  const note = path.join(root, '.note');
  fs.mkdirSync(note, { recursive: true });
  probe = new BashGuardProbe(h);
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath: root })).toEqual([]);
  const curator = probe.launch(ws.dir, ['R', 'E', 'D']);
  expect(h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: curator })).toEqual([]);
  return { note, other: probe.launch(ws.dir, ['R', 'E', 'D']), curator };
}

const writes = (note: string) => [
  `python3 -c "open('${note}/a.md','w')"`,
  `node -e "require('fs').writeFileSync('${note}/a.md','x')"`,
  `curl -o "${note}/x" u`,
  `curl -o"${note}/x" u`,
  `sed -n "w ${note}/a.md" f`,
  `python3 <<< "open('${note}/a.md','w')"`,
  `python3 - <<'EOF'\nopen("${note}/a.md", "w")\nEOF`,
];

describe.each([
  ['a space', 'my proj'],
  ['two spaces and a tab-like name', 'my  proj x'],
  ['a quote character', "it's root"],
  ['a backslash (POSIX)', 'back\\slash'],
])('Workspace root containing %s (P2-4)', (_label, rootName) => {
  it('non-curators are denied (server and hook), the curator is allowed', () => {
    const { note, other, curator } = setup(rootName);
    const p = probe as BashGuardProbe;
    for (const command of writes(note)) {
      expect(p.bash(other, command), command).toMatchObject({ verdict: 'deny' });
      expect([WORKSPACE, UNRESOLVED]).toContain((p.bash(other, command) as { rule: string }).rule);
      expect(p.plan(other, 'Bash', { command }).fallback.decision, command).toBe('deny');
      expect(p.bash(curator, command), command).toEqual({ verdict: 'allow' });
    }
    // 讀取類不受影響。
    expect(p.bash(other, `cat "${note}/a.md"`)).toEqual({ verdict: 'allow' });
  });
});

describe.runIf(process.platform === 'darwin')('Unicode roots (darwin folds NFC/NFD)', () => {
  it('an NFC root written as NFD in the command is still caught', () => {
    const { note, other } = setup('caf\u00e9 root');
    const nfd = note.normalize('NFD');
    expect(nfd).not.toBe(note);
    expect(probe?.bash(other, `python3 -c "open('${nfd}/a.md','w')"`)).toMatchObject({
      rule: WORKSPACE,
    });
  });
});

describe('F17 with a HOME containing spaces (server side)', () => {
  it('a literal ~/.claude/settings.json path with spaces is protected-config', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl home ')));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, 'ws'));
    const store = new AgentStateStore();
    const guard = new WriteGuard({
      store,
      ptyManager: { has: () => true },
      homeDir: () => home,
      workspaces: () => [
        { id: 'default', name: 'Default', directoryPaths: [], rootPath: path.join(home, 'ws') },
      ],
    });
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        projectDir: home,
        jsonlFile: path.join(home, 's.jsonl'),
        isExternal: false,
        directoryRealPath: home,
      }),
    );
    const settings = path.join(home, '.claude', 'settings.json');
    for (const command of [`python3 -c "open('${settings}','w')"`, `curl -o "${settings}" u`]) {
      expect(
        guard.verdict({ tool_name: 'Bash', session_id: 's', cwd: '/tmp', paths: [], command }),
        command,
      ).toMatchObject({ rule: CONFIG });
    }
    guard.dispose();
    store.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("$'...' decoding (P2-2)", () => {
  it.each([
    ["$'\\x2e'", '.'],
    ["$'\\u002e'", '.'],
    ["$'\\U0000002e'", '.'],
    ["$'\\056'", '.'],
    ["$'\\cA'", '\u0001'],
    ["$'\\e\\a\\b\\f\\n\\r\\t\\v'", '\u001b\u0007\b\f\n\r\t\v'],
    ["$'\\\\\\'\\\"\\?'", '\\\'"?'],
    ["$'\\q'", '\\q'],
  ])('%s decodes', (src, expected) => {
    expect(decodeAnsiC(src, 0)).toMatchObject({ text: expected, unresolved: false });
  });

  it.each(["$'\\U00110000'", "$'\\uD800'", "$'\\u'", "$'\\c'", "$'unterminated"])(
    '%s is unresolved',
    (src) => {
      expect(decodeAnsiC(src, 0).unresolved).toBe(true);
      expect(analyzeBash(`touch ${src}`).truncated).toBe(true);
    },
  );
});

describe('command names are case-folded on darwin and win32 only (P2-7)', () => {
  const word = (text: string) => ({
    text,
    quoted: false,
    expansion: false,
    tilde: false,
    assignment: false,
    substitutions: [],
  });

  it.each([
    ['RM', 'darwin', 'rm'],
    ['/bin/Rm', 'darwin', 'rm'],
    ['RM.EXE', 'win32', 'rm'],
    ['C:\\bin\\Rm.cmd', 'win32', 'rm'],
    ['RM', 'linux', 'RM'],
    ['=rm', 'linux', 'rm'],
  ] as const)('%s on %s is %s', (name, platform, expected) => {
    expect(commandName(word(name), platform)).toBe(expected);
  });

  it('classification follows the injected platform', () => {
    expect(analyzeBash('RM -rf src', { platform: 'darwin' }).ops).toEqual(['delete']);
    expect(analyzeBash('RM -rf src', { platform: 'win32' }).ops).toEqual(['delete']);
    expect(analyzeBash('RM -rf src', { platform: 'linux' }).ops).toEqual(['edit']);
  });
});
