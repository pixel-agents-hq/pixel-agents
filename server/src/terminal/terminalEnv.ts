import { TERMINAL_DEFAULT_LANG, TERMINAL_TERM_NAME } from '../constants.js';

/**
 * The environment a terminal runs with: the one asked for, with TERM set
 * and, when it names no locale (LC_ALL, LC_CTYPE or LANG), a UTF-8 one.
 * Terminal.app and iTerm set LANG the same way; a locale the user chose,
 * UTF-8 or not, is left alone.
 */
export function terminalEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const hasLocale = ['LC_ALL', 'LC_CTYPE', 'LANG'].some((key) => !!env[key]);
  return {
    ...env,
    ...(hasLocale ? {} : { LANG: TERMINAL_DEFAULT_LANG }),
    TERM: TERMINAL_TERM_NAME,
  };
}
