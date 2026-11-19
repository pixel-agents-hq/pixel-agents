import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli.js';
import { claudeTrustPromptKeys } from '../src/providers/hook/claude/trustPrompt.js';
import type { TerminalSession } from '../src/terminal/terminalSessions.js';
import { answerTrustPrompt } from '../src/terminal/trustPrompt.js';

// The question as Claude Code 2.1.322 draws it.
const QUESTION = [
  'Accessing workspace:',
  '',
  '/home/someone/project',
  '',
  'Quick safety check: Is this a project you created or one you trust?',
  '',
  "Claude Code'll be able to read, edit, and execute files here.",
  '',
  'Security guide',
  '',
  '❯ No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

describe('claudeTrustPromptKeys', () => {
  it('moves the pointer from "No, exit" to yes, then confirms', () => {
    expect(claudeTrustPromptKeys(QUESTION)).toEqual(['down', 'enter']);
  });

  it('only confirms when the pointer is on yes already', () => {
    const onYes = QUESTION.replace('❯ No, exit', '  No, exit').replace(
      '  Yes, I trust',
      '❯ Yes, I trust',
    );
    expect(claudeTrustPromptKeys(onYes)).toEqual(['enter']);
  });

  it('goes up when a later version lists yes first', () => {
    const flipped = QUESTION.replace(
      '❯ No, exit\n  Yes, I trust this folder',
      '  Yes, I trust this folder\n❯ No, exit',
    );
    expect(claudeTrustPromptKeys(flipped)).toEqual(['up', 'enter']);
  });

  it('leaves alone any screen that is not plainly the question', () => {
    expect(claudeTrustPromptKeys('')).toBeNull();
    expect(claudeTrustPromptKeys('❯ Try "fix the failing test"')).toBeNull();
    // The words without the menu (an agent talking about it).
    expect(claudeTrustPromptKeys('Pick "Yes, I trust this folder" when asked.')).toBeNull();
    // Both rows, no pointer on either: not a menu we know how to answer.
    expect(claudeTrustPromptKeys('  No, exit\n  Yes, I trust this folder')).toBeNull();
  });
});

/** A session whose screen is whatever `frames` says next. */
function fakeSession(frames: string[]): { session: TerminalSession; written: string[] } {
  const written: string[] = [];
  let i = 0;
  const session = {
    replay: async () => ({
      data: frames[Math.min(i++, frames.length - 1)].replace(/\n/g, '\r\n'),
      cols: 100,
      rows: 30,
    }),
    write: (bytes: string) => void written.push(bytes),
  } as unknown as TerminalSession;
  return { session, written };
}

const ON_YES = QUESTION.replace('❯ No, exit', '  No, exit').replace(
  '  Yes, I trust',
  '❯ Yes, I trust',
);

/** A session showing the question as the CLI does: a move puts the pointer on
 *  the other row, Enter confirms the pointed one (the test fails on "No,
 *  exit"), and the first `dropped` keys are ignored. */
function questionSession(opts: { dropped?: number } = {}): {
  session: TerminalSession;
  written: string[];
} {
  const written: string[] = [];
  let screen: 'no' | 'yes' | 'gone' = 'no';
  let dropped = opts.dropped ?? 0;
  const session = {
    replay: async () => ({
      data: (screen === 'no' ? QUESTION : screen === 'yes' ? ON_YES : '❯ ').replace(/\n/g, '\r\n'),
      cols: 100,
      rows: 30,
    }),
    write: (bytes: string) => {
      written.push(bytes);
      if (dropped-- > 0 || screen === 'gone') return;
      if (bytes === '\r') {
        if (screen === 'no') throw new Error('confirmed "No, exit"');
        screen = 'gone';
      } else screen = screen === 'no' ? 'yes' : 'no';
    },
  } as unknown as TerminalSession;
  return { session, written };
}

const FAST = { pollMs: 1, watchMs: 300 };
const claude = { trustPromptKeys: claudeTrustPromptKeys };

describe('answerTrustPrompt', () => {
  it('moves, reads the screen again, and confirms only with the pointer on yes', async () => {
    const { session, written } = questionSession();
    expect(await answerTrustPrompt(session, claude, () => true, FAST)).toBe(true);
    expect(written).toEqual(['\x1b[B', '\r']);
  });

  it('never confirms "No, exit" when the CLI drops the first keys', async () => {
    // Claude Code ignores keys for a moment after the question appears: a
    // "down, enter" sent together lost the move and confirmed "No, exit".
    const { session, written } = questionSession({ dropped: 2 });
    expect(await answerTrustPrompt(session, claude, () => true, FAST)).toBe(true);
    expect(written).toEqual(['\x1b[B', '\x1b[B', '\x1b[B', '\r']);
  });

  it('reports no answer while the question stays on the screen', async () => {
    const { session, written } = questionSession({ dropped: Infinity });
    expect(await answerTrustPrompt(session, claude, () => true, { pollMs: 1, watchMs: 30 })).toBe(
      false,
    );
    expect(written.every((bytes) => bytes === '\x1b[B')).toBe(true);
  });

  it('types nothing where the question never shows', async () => {
    const { session, written } = fakeSession(['❯ Try "fix the failing test"']);
    expect(await answerTrustPrompt(session, claude, () => true, { pollMs: 1, watchMs: 30 })).toBe(
      false,
    );
    expect(written).toEqual([]);
  });

  it('stops when the terminal is gone', async () => {
    const { session, written } = fakeSession([QUESTION]);
    expect(await answerTrustPrompt(session, claude, () => false, FAST)).toBe(false);
    expect(written).toEqual([]);
  });

  it('does nothing for a provider with no such question', async () => {
    const { session, written } = fakeSession([QUESTION]);
    expect(await answerTrustPrompt(session, {}, () => true, FAST)).toBe(false);
    expect(written).toEqual([]);
  });
});

describe('--trust-directories', () => {
  it('is off unless asked for', () => {
    expect(parseArgs([]).trustDirectories).toBe(false);
    expect(parseArgs(['--trust-directories']).trustDirectories).toBe(true);
  });
});
