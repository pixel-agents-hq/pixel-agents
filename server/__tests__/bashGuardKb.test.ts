/**
 * P3：Bash 寫入目標套用 P2 的 KB 規則與 F17（不論有無角色）。真的 store、launcher、
 * curator 表與 WriteGuard；hook 端解析與伺服器端解析都走真的程式。驗收 3、4、9、7。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WRITE_GUARD_RULE_KB_PERSONAL as PERSONAL,
  WRITE_GUARD_RULE_KB_WORKSPACE as WORKSPACE,
  WRITE_GUARD_RULE_KB_WORKSPACE_NO_WRITER as NO_WRITER,
  WRITE_GUARD_RULE_PROTECTED_CONFIG as CONFIG,
} from '../src/constants.js';
import { writeRoleSnapshot } from '../src/roleStorage.js';
import { BashGuardProbe } from './bashGuardProbe.js';
import { KbHarness } from './curatorHarness.js';

let h: KbHarness;
let probe: BashGuardProbe;
let ws: { id: string; dir: string };
let root: string;
let note: string;
const ALLOW = { verdict: 'allow' };

beforeEach(() => {
  h = new KbHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ws = h.workspace('alpha');
  root = path.join(h.tempHome, 'alpha-root');
  note = path.join(root, '.note');
  fs.mkdirSync(note, { recursive: true });
  fs.writeFileSync(path.join(note, 'a.md'), 'a');
  fs.writeFileSync(path.join(ws.dir, 'src.md'), 's');
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath: root })).toEqual([]);
  probe = new BashGuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

const appoint = (agentId: number) =>
  expect(h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId })).toEqual([]);

async function launchWithRole(roleId: string): Promise<number> {
  const snapshotPath = await writeRoleSnapshot(Buffer.from('# role\n'));
  const { id } = h.launch({ directoryPath: ws.dir, role: { name: 'r', roleId, snapshotPath } });
  if (id === null) throw new Error('launch failed');
  return id;
}

/** 以 Bash 寫入工作空間 KB 的各種方式（驗收 3）。 */
const workspaceWrites = () => [
  `echo x > ${note}/a.md`,
  `echo x >> ${note}/a.md`,
  `printf x | tee ${note}/b.md`,
  `sed -i s/a/b/ ${note}/a.md`,
  `cp src.md ${note}/`,
  `cp src.md ${note}/c.md`,
  `mv src.md ${note}/d.md`,
  `mv ${note}/a.md /tmp/stolen.md`,
  `rm ${note}/a.md`,
  `rm -rf ${root}`,
  `cat <<'EOF' > ${note}/e.md\nbody\nEOF`,
];

describe('Workspace KB through Bash (acceptance 3)', () => {
  it.each([null, ['R', 'E', 'D'] as const])(
    'non-curators are denied every write form, curators allowed (roles %j)',
    (roles) => {
      const curator = probe.launch(ws.dir, roles === null ? null : [...roles]);
      const other = probe.launch(ws.dir, roles === null ? null : [...roles]);
      appoint(curator);
      for (const command of workspaceWrites()) {
        expect(probe.bash(other, command), command).toMatchObject({ rule: WORKSPACE });
        expect(probe.bash(curator, command), command).toEqual(ALLOW);
      }
    },
  );

  it('reading the Workspace KB with cat or grep is unaffected', () => {
    const other = probe.launch(ws.dir);
    expect(probe.bash(other, `cat ${note}/a.md && grep -r a ${note} | head`)).toEqual(ALLOW);
  });
});

describe('personal KB through Bash (acceptance 3)', () => {
  it('own identity key is writable; another key, an unused key and the bare .note/ are not', async () => {
    const plain = probe.launch(ws.dir);
    const writer = await launchWithRole('writer.md');
    expect(probe.bash(plain, 'echo x > .note/_default/a.md')).toEqual(ALLOW);
    expect(
      probe.bash(writer, 'mkdir -p .note/writer.md && tee .note/writer.md/a < /dev/null'),
    ).toEqual(ALLOW);
    for (const command of [
      'echo x > .note/writer.md/a.md',
      'cp src.md .note/unused.md/',
      'touch .note/loose.md',
      'rm -rf .note',
      `rm -rf ${ws.dir}`,
    ]) {
      expect(probe.bash(plain, command), command).toMatchObject({ rule: PERSONAL });
    }
    expect(probe.bash(writer, 'sed -i s/a/b/ .note/_default/a.md')).toMatchObject({
      rule: PERSONAL,
    });
  });
});

describe('cd and relative paths (acceptance 4, F17, F6)', () => {
  it('cd elsewhere first does not open the Directory .claude/ or the Workspace .note/', () => {
    const agent = probe.launch(ws.dir);
    const claude = path.join(ws.dir, '.claude');
    expect(probe.bash(agent, `cd /tmp && echo x > ${claude}/settings.json`)).toMatchObject({
      rule: CONFIG,
    });
    // 尚未任命 curator：工作空間 KB 對所有已知 Agent 都 deny（建議指派 KB Writer）。
    expect(probe.bash(agent, `cd ${root} && echo x > .note/a.md`)).toMatchObject({
      rule: NO_WRITER,
    });
    expect(probe.bash(agent, `cd /tmp; echo x > .claude/settings.json`)).toMatchObject({
      rule: CONFIG,
    });
    expect(probe.bash(agent, 'mkdir -p sub && cd sub && echo x > ../.claude/x')).toMatchObject({
      rule: CONFIG,
    });
    expect(probe.bash(agent, 'echo x > ~/.claude/settings.json')).toMatchObject({ rule: CONFIG });
    expect(probe.bash(agent, 'rm -rf ~')).toMatchObject({ verdict: 'deny' });
    expect(probe.bash(agent, 'cd /tmp && echo x > out.txt')).toEqual(ALLOW);
  });

  it('a relative target is checked against BOTH the payload cwd and the Agent Directory', () => {
    const agent = probe.launch(ws.dir);
    const elsewhere = path.join(h.tempHome, 'elsewhere');
    fs.mkdirSync(elsewhere);
    // payload cwd 跟著先前的 cd 走（假設）；Agent Directory 候選由伺服器以字面語意補上。
    expect(probe.bash(agent, 'echo x > .claude/settings.json', elsewhere)).toMatchObject({
      rule: CONFIG,
    });
    expect(probe.bash(agent, 'echo x > .note/other.md/a', elsewhere)).toMatchObject({
      rule: PERSONAL,
    });
    // payload cwd 那一側命中也算：cwd 在工作空間根目錄。
    expect(probe.bash(agent, 'echo x > .note/a.md', root)).toMatchObject({ rule: NO_WRITER });
    expect(probe.bash(agent, 'echo x > notes.txt', elsewhere)).toEqual(ALLOW);
  });
});

describe('interpreters and unclassified commands (acceptance 9)', () => {
  it('a literal protected path anywhere in their words is a potential write', () => {
    const other = probe.launch(ws.dir, ['R', 'E']);
    const curator = probe.launch(ws.dir, ['R', 'E']);
    appoint(curator);
    const commands = [
      `python -c "open('${note}/x','w').write('y')"`,
      `bash -c 'echo y > ${note}/x'`,
      `node -e "require('fs').writeFileSync('${note}/x','y')"`,
      `npm run build -- --out=${note}/dist`,
    ];
    for (const command of commands) {
      expect(probe.bash(other, command), command).toMatchObject({ rule: WORKSPACE });
      expect(probe.bash(curator, command), command).toEqual(ALLOW);
    }
    expect(
      probe.bash(other, `python -c "print('${path.join(ws.dir, '.claude', 'x')}')"`),
    ).toMatchObject({ rule: CONFIG });
    expect(probe.bash(other, 'python script.py && npm test')).toEqual(ALLOW);
  });
});

describe('everyday commands stay allowed while KB rules are on', () => {
  it('build, test, git and file commands outside the KB zones are not blocked', () => {
    const agent = probe.launch(ws.dir, ['R', 'E']);
    for (const command of [
      'npm run build 2>&1 | tail -20',
      'git status && git diff --stat',
      'mkdir -p src/x && cp src.md src/x/',
      'python3 -m pytest -q',
      'cd sub && npx vitest run',
      'git add -A && git commit -m "$(cat <<\'EOF\'\nfix .note/a.md handling\nEOF\n)"',
      `ls ${note} && cat ${note}/a.md`,
    ]) {
      expect(probe.bash(agent, command), command).toEqual(ALLOW);
    }
  });
});

describe('out of scope, recorded as not blocked (acceptance 7)', () => {
  it.each([
    ['variable expansion', `d=${note}; echo x > $d/a.md`],
    ['glob expansion', `echo x > ${root}/.no*/a.md`],
    ['eval', `eval "echo x > \\$D/a.md"`],
    ['base64 decoding', 'echo ZWNobyB4ID4gLm5vdGUvYS5tZAo= | base64 -d | sh'],
    ['a script piped into sh', "echo 'touch .note/x' | sh"],
    ['brace expansion', `touch ${root}/.{note,tmp}/a.md`],
  ])('known limitation (not blocked): %s', (_label, command) => {
    const agent = probe.launch(ws.dir);
    expect(probe.bash(agent, command)).toEqual(ALLOW);
  });
});
