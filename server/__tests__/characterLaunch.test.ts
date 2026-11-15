/**
 * Per-character launch settings: the validator, the Claude agent definitions
 * the Characters view lists, the flags they become, and when a launch wears
 * them (a character chosen, never a random look).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCharacterLaunch, parseCharacterProfiles } from '../../core/src/characterProfiles.js';
import type { Directory } from '../../core/src/messages.js';
import { chosenLaunchSettings } from '../src/paletteAssigner.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { listClaudeAgents, readFrontmatter } from '../src/providers/hook/claude/claudeAgents.js';

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launch-'));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeProfiles(profiles: unknown[]): void {
  const dir = path.join(home, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify(profiles));
}

describe('isCharacterLaunch', () => {
  it('accepts roles, models and efforts a command line carries safely', () => {
    expect(isCharacterLaunch({})).toBe(true);
    expect(isCharacterLaunch({ agent: 'shopify-dev', model: 'opus', effort: 'high' })).toBe(true);
    expect(isCharacterLaunch({ model: 'claude-opus-5-5' })).toBe(true);
    expect(isCharacterLaunch({ model: 'sonnet[1m]' })).toBe(true);
  });

  it('refuses anything a shell would read, unknown efforts and unknown fields', () => {
    expect(isCharacterLaunch({ agent: 'qc; rm -rf ~' })).toBe(false);
    expect(isCharacterLaunch({ agent: '$(whoami)' })).toBe(false);
    expect(isCharacterLaunch({ model: 'opus --dangerously-skip-permissions' })).toBe(false);
    expect(isCharacterLaunch({ model: '' })).toBe(false);
    expect(isCharacterLaunch({ effort: 'extreme' })).toBe(false);
    expect(isCharacterLaunch({ prompt: 'hi' })).toBe(false);
  });

  it('a profile list with a bad launch is refused whole, like any bad field', () => {
    expect(parseCharacterProfiles([{ body: 'flat', launch: { agent: 'qc' } }])).not.toBeNull();
    expect(parseCharacterProfiles([{ body: 'flat', launch: { agent: 'a b' } }])).toBeNull();
  });
});

describe('Claude launch flags', () => {
  const build = claudeProvider.buildLaunchCommand!;

  it('adds --agent, --model and --effort after the session flags', () => {
    expect(build('s', '/w', { agent: 'qc', model: 'sonnet', effort: 'low' }).args).toEqual([
      '--session-id',
      's',
      '--agent',
      'qc',
      '--model',
      'sonnet',
      '--effort',
      'low',
    ]);
  });

  it('adds nothing for absent settings, and refuses unsafe ones whole', () => {
    expect(build('s', '/w', {}).args).toEqual(['--session-id', 's']);
    expect(build('s', '/w', { agent: 'qc', model: 'x;y' }).args).toEqual(['--session-id', 's']);
  });

  it('keeps them on a resume', () => {
    expect(build('s', '/w', { resume: true, model: 'opus' }).args).toEqual([
      '--resume',
      's',
      '--model',
      'opus',
    ]);
  });
});

describe('Claude agent definitions', () => {
  it('reads name, description and model from the frontmatter', () => {
    expect(
      readFrontmatter('---\nname: qc\ndescription: "Checks things"\nmodel: sonnet\n---\nBody'),
    ).toEqual({ name: 'qc', description: 'Checks things', model: 'sonnet' });
    expect(readFrontmatter('no frontmatter')).toBeNull();
    expect(readFrontmatter('---\nname: never closed\n')).toBeNull();
  });

  it("lists the user's own, then each Directory's, skipping names no command line carries", () => {
    const userDir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'qc.md'), '---\nname: qc\nmodel: inherit\n---\n');
    fs.writeFileSync(path.join(userDir, 'bad.md'), '---\nname: two words\n---\n');
    fs.writeFileSync(path.join(userDir, 'notes.txt'), 'ignored');
    const project = path.join(home, 'shop');
    fs.mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'agents', 'shopify-dev.md'),
      '---\nname: shopify-dev\ndescription: Liquid\nmodel: opus\n---\n',
    );

    expect(listClaudeAgents([project, project, path.join(home, 'missing')])).toEqual([
      { name: 'qc', scope: 'user' },
      {
        name: 'shopify-dev',
        description: 'Liquid',
        model: 'opus',
        scope: 'project',
        directory: project,
      },
    ]);
  });

  it('names a definition without a name after its file', () => {
    const userDir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'designer.md'), '# just markdown');
    expect(listClaudeAgents([])).toEqual([{ name: 'designer', scope: 'user' }]);
  });
});

describe('chosenLaunchSettings', () => {
  const launch = { agent: 'qc', model: 'sonnet' };

  beforeEach(() => {
    writeProfiles([
      { id: 'a', body: 'flat', v: 35 },
      { id: 'b', body: 'flat', v: 35, launch },
      { id: 'c', body: 'flat', v: 35, launch: {} },
    ]);
  });

  it("a roster pick wears its character's settings", () => {
    expect(chosenLaunchSettings(1, { picked: 1 })).toEqual(launch);
  });

  it('so does a Directory default', () => {
    const directory = { name: 'd', path: '/d', source: 'user', characters: [1] } as Directory;
    expect(chosenLaunchSettings(1, { directory })).toEqual(launch);
  });

  it('a random look launches plainly', () => {
    expect(chosenLaunchSettings(1, {})).toBeUndefined();
    expect(chosenLaunchSettings(1, { picked: 0 })).toBeUndefined();
  });

  it('a character without settings, or with empty ones, adds nothing', () => {
    expect(chosenLaunchSettings(0, { picked: 0 })).toBeUndefined();
    expect(chosenLaunchSettings(2, { picked: 2 })).toBeUndefined();
    expect(chosenLaunchSettings(undefined, { picked: 1 })).toBeUndefined();
  });
});
