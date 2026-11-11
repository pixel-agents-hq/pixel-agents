/**
 * The backup predicate's verdicts, pinned case by case: which settings.json
 * contents count as entirely our own output (no backup before replacing them)
 * and which hold something of the user's. Both halves are checked against the
 * writers (makeHookEntry, makeBareStatusLine), so fresh install output must
 * always read as ours.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { settingsHoldOnlyOurOutput } =
  await import('../src/providers/hook/claude/claudeSettingsFile.js');
const { installHooks } = await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { isBareOurStatusLine, makeBareStatusLine } =
  await import('../src/providers/hook/claude/statusLineBridge.js');

const OUR_HOOK = 'node "/home/u/.pixel-agents/hooks/claude-hook.js"';
const OUR_STATUSLINE = 'node "/home/u/.pixel-agents/hooks/claude-statusline.js"';
const WRAPPED_STATUSLINE = `${OUR_STATUSLINE} --wrap ${Buffer.from('echo hi').toString('base64url')}`;

const ourEntry = (hook: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) => ({
  matcher: '',
  hooks: [{ type: 'command', command: OUR_HOOK, timeout: 5, ...hook }],
  ...entry,
});
const bare = { type: 'command', command: OUR_STATUSLINE };

describe('isBareOurStatusLine', () => {
  it.each<[string, unknown, boolean]>([
    ['our bare command', bare, true],
    ['our bare command, keys in another order', { command: OUR_STATUSLINE, type: 'command' }, true],
    [
      'our bare command, cased path',
      { type: 'command', command: 'node "/home/u/.Pixel-Agents/Hooks/Claude-StatusLine.js"' },
      true,
    ],
    ['an extra field', { ...bare, padding: 0 }, false],
    ['no type', { command: OUR_STATUSLINE }, false],
    ['another type', { type: 'static', command: OUR_STATUSLINE }, false],
    ['a wrapped command', { type: 'command', command: WRAPPED_STATUSLINE }, false],
    ['a hand-edited command', { type: 'command', command: `${OUR_STATUSLINE} --x` }, false],
    ['a foreign command', { type: 'command', command: 'bash ~/s.sh' }, false],
    ['a non-string command', { type: 'command', command: 1 }, false],
    ['null', null, false],
    ['a string', OUR_STATUSLINE, false],
    ['an array', [bare], false],
    ['undefined', undefined, false],
  ])('%s → %s', (_label, value, verdict) => {
    expect(isBareOurStatusLine(value)).toBe(verdict);
  });

  it('holds for what install writes (the writer and the predicate stay one)', () => {
    expect(
      isBareOurStatusLine(makeBareStatusLine('/home/u/.pixel-agents/hooks/claude-statusline.js')),
    ).toBe(true);
    expect(
      isBareOurStatusLine(
        makeBareStatusLine('C:\\Users\\u\\.pixel-agents\\hooks\\claude-statusline.js'),
      ),
    ).toBe(true);
  });
});

describe('settingsHoldOnlyOurOutput', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ownership-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it.each<[string, unknown, boolean]>([
    ['an empty file', {}, true],
    ['an empty hooks object', { hooks: {} }, true],
    ['our entries', { hooks: { Stop: [ourEntry()], PreToolUse: [ourEntry()] } }, true],
    ['our entries with another timeout', { hooks: { Stop: [ourEntry({ timeout: 30 })] } }, true],
    [
      'our entries without a timeout',
      { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: OUR_HOOK }] }] } },
      true,
    ],
    ['two of our entries in one event', { hooks: { Stop: [ourEntry(), ourEntry()] } }, true],
    ['our bare status line alone', { statusLine: bare }, true],
    [
      'our entries and our bare status line',
      { hooks: { Stop: [ourEntry()] }, statusLine: bare },
      true,
    ],
    ['a top-level array', [], false],
    ['a top-level number', 5, false],
    ['a top-level string', 'x', false],
    ['a top-level null', null, false],
    [
      'a wrapped status line',
      {
        hooks: { Stop: [ourEntry()] },
        statusLine: { type: 'command', command: WRAPPED_STATUSLINE },
      },
      false,
    ],
    ['a status line with padding', { statusLine: { ...bare, padding: 2 } }, false],
    ['a foreign status line', { statusLine: { type: 'command', command: 'bash ~/s.sh' } }, false],
    ['a null status line', { statusLine: null }, false],
    ['another top-level key', { hooks: { Stop: [ourEntry()] }, model: 'opus' }, false],
    ['hooks as an array', { hooks: [] }, false],
    ['hooks null', { hooks: null }, false],
    ['hooks a string', { hooks: 'x' }, false],
    ['an empty event array', { hooks: { Stop: [] } }, false],
    ['a non-array event', { hooks: { Stop: {} } }, false],
    ['a null entry', { hooks: { Stop: [null] } }, false],
    ['an array entry', { hooks: { Stop: [[]] } }, false],
    ['a non-empty matcher', { hooks: { Stop: [ourEntry({}, { matcher: 'Bash' })] } }, false],
    ['an unknown entry field', { hooks: { Stop: [ourEntry({}, { note: 1 })] } }, false],
    ['an entry with no hooks', { hooks: { Stop: [{ matcher: '' }] } }, false],
    ['an entry with empty hooks', { hooks: { Stop: [{ matcher: '', hooks: [] }] } }, false],
    ['a foreign command', { hooks: { Stop: [ourEntry({ command: 'node /opt/x.js' })] } }, false],
    [
      'a foreign hook beside ours',
      {
        hooks: {
          Stop: [
            { matcher: '', hooks: [ourEntry().hooks[0], { type: 'command', command: 'echo' }] },
          ],
        },
      },
      false,
    ],
    ['a non-command hook type', { hooks: { Stop: [ourEntry({ type: 'prompt' })] } }, false],
    ['an unknown hook field', { hooks: { Stop: [ourEntry({ async: true })] } }, false],
    ['a null hook', { hooks: { Stop: [{ matcher: '', hooks: [null] }] } }, false],
  ])('%s → %s', (_label, settings, verdict) => {
    expect(settingsHoldOnlyOurOutput(settings as Record<string, unknown>)).toBe(verdict);
  });

  it('holds for what the hook installer writes into a fresh home', async () => {
    await installHooks();
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpBase, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settingsHoldOnlyOurOutput(written)).toBe(true);
  });
});
