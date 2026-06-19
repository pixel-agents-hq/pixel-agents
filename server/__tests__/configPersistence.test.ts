import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { readConfig, writeConfig } = await import('../src/configPersistence.js');

describe('configPersistence dormantProjects', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cfg-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns empty dormantProjects when no config file exists', () => {
    const cfg = readConfig();
    expect(cfg.dormantProjects).toEqual([]);
  });

  it('round-trips dormantProjects through writeConfig/readConfig', () => {
    const project = {
      projectDir: '/home/.claude/projects/-foo',
      workspacePath: '/foo',
      displayName: 'foo',
      skills: ['brainstorming'],
      hidden: false,
      lastSeenAt: 1234567890,
    };
    const cfg = readConfig();
    cfg.dormantProjects = [project];
    writeConfig(cfg);
    const loaded = readConfig();
    expect(loaded.dormantProjects).toHaveLength(1);
    expect(loaded.dormantProjects[0]).toEqual(project);
  });

  it('silently drops invalid entries in dormantProjects', () => {
    const pxlDir = path.join(tmpBase, '.pixel-agents');
    fs.mkdirSync(pxlDir, { recursive: true });
    fs.writeFileSync(
      path.join(pxlDir, 'config.json'),
      JSON.stringify({
        dormantProjects: [
          null,
          { projectDir: 123 },
          { projectDir: '/x', workspacePath: '/x', displayName: 'x', skills: [], hidden: false },
        ],
      }),
      'utf-8',
    );
    const cfg = readConfig();
    expect(cfg.dormantProjects).toHaveLength(1);
    expect(cfg.dormantProjects[0].displayName).toBe('x');
  });
});
