import { useEffect } from 'react';

/** Hands the greeter's lines for a step up to the Intro's dialog. */
export type Say = (lines: readonly string[]) => void;

/**
 * A step's menu saying what the greeter speaks while it is up: the dialog
 * shows `lines` (cut into messages, introDialogRules.ts) and the menu once the
 * last is out. Said again whenever the lines change.
 */
export function useSay(say: Say, lines: readonly string[]): void {
  const text = lines.join('\n');
  useEffect(() => {
    say(text === '' ? [] : text.split('\n'));
  }, [say, text]);
}
