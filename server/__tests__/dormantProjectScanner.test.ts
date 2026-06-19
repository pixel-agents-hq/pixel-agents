import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { scanDormantProjects } = await import('../src/dormantProjectScanner.js');

function makeProjectDir(name: string, jsonl?: string): string {
  const pDir = path.join(tmpBase, '.claude', 'projects', name);
  fs.mkdirSync(pDir, { recursive: true });
  if (jsonl) {
    fs.writeFileSync(path.join(pDir, 'session.jsonl'), jsonl, 'utf-8');
  }
  return pDir;
}

describe('scanDormantProjects', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-scan-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns [] when ~/.claude/projects does not exist', async () => {
    const result = await scanDormantProjects([]);
    expect(result).toEqual([]);
  });

  it('discovers a project dir and decodes displayName from dirname', async () => {
    makeProjectDir('-Users-alice-myrepo');
    const result = await scanDormantProjects([]);
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('myrepo');
    expect(result[0].skills).toEqual([]);
    expect(result[0].hidden).toBe(false);
  });

  it('extracts cwd from JSONL record with a cwd field', async () => {
    makeProjectDir(
      '-Users-alice-myrepo',
      JSON.stringify({
        type: 'attachment',
        cwd: '/Users/alice/myrepo',
      }),
    );
    const result = await scanDormantProjects([]);
    expect(result[0].workspacePath).toBe('/Users/alice/myrepo');
    expect(result[0].displayName).toBe('myrepo');
  });

  it('preserves skills and hidden from existingProjects on known dirs', async () => {
    const projectDir = makeProjectDir('-Users-alice-myrepo');
    const result = await scanDormantProjects([
      {
        projectDir,
        workspacePath: '/Users/alice/myrepo',
        displayName: 'myrepo',
        skills: ['brainstorming'],
        hidden: true,
      },
    ]);
    expect(result[0].skills).toEqual(['brainstorming']);
    expect(result[0].hidden).toBe(true);
  });

  it('prunes existingProjects whose projectDir no longer exists', async () => {
    const result = await scanDormantProjects([
      {
        projectDir: path.join(tmpBase, '.claude', 'projects', '-gone'),
        workspacePath: '/gone',
        displayName: 'gone',
        skills: [],
        hidden: false,
      },
    ]);
    expect(result).toHaveLength(0);
  });

  it('caps results at DORMANT_PROJECTS_MAX (20)', async () => {
    for (let i = 0; i < 25; i++) {
      makeProjectDir(`-Users-alice-repo${i}`);
    }
    const result = await scanDormantProjects([]);
    expect(result).toHaveLength(20);
  });
});
