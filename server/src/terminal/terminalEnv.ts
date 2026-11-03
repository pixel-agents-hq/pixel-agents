import type { HookProvider } from '../../../core/src/provider.js';
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

/** This process's env as plain strings (process.env is `string | undefined`-valued,
 *  a PTY env all-strings): what an agent's terminal runs with, under its own
 *  variables. Built here, by the server, so a PTY host started long ago by an
 *  older server never lends its own. Without the provider's session markers
 *  (`isInheritedSessionEnv`): a server started inside a CLI session would
 *  otherwise make every agent it launches a child of that session. */
export function inheritedEnv(
  provider: Pick<HookProvider, 'isInheritedSessionEnv'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || provider.isInheritedSessionEnv?.(key)) continue;
    env[key] = value;
  }
  return env;
}

/** The same markers for a host that hands a terminal only overrides (VS Code's
 *  createTerminal `env`, where null unsets a variable the host would pass on). */
export function sessionMarkersUnset(
  provider: Pick<HookProvider, 'isInheritedSessionEnv'>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, null> {
  const unset: Record<string, null> = {};
  for (const key of Object.keys(env)) {
    if (provider.isInheritedSessionEnv?.(key)) unset[key] = null;
  }
  return unset;
}
