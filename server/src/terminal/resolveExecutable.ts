/**
 * Resolves the program a standalone PTY launch hands to node-pty.
 *
 * Providers describe a launch platform-agnostically (`claude` plus args) and
 * leave the lookup to whoever runs it. The VS Code adapter runs it through a
 * shell, which resolves the name. The standalone surface spawns it directly,
 * and on Windows node-pty's ConPTY backend does its own lookup: it joins each
 * PATH directory with the literal name and checks that the file exists. It
 * never applies PATHEXT, so `claude` never matches `claude.exe`, and the spawn
 * throws `File not found: ` with an empty path (the native lookup's empty
 * result). An npm-installed `claude.cmd` is a second trap on the same path:
 * CreateProcess cannot run a batch script directly, it has to go through
 * `cmd.exe /d /s /c` -- what Node's own child_process does for `shell: true`.
 *
 * So on Windows the name is resolved HERE, with cmd.exe's rules (PATH order,
 * then PATHEXT order within a directory, case-insensitive), before the PTY
 * module sees it. Other platforms pass the launch through untouched.
 *
 * Pure: platform, env and the filesystem probe are injected, so every branch
 * is unit-testable on every host.
 */

import * as path from 'path';

import {
  WINDOWS_CMD_FLAGS,
  WINDOWS_COMSPEC_ENV,
  WINDOWS_DEFAULT_COMSPEC,
  WINDOWS_DEFAULT_PATHEXT,
  WINDOWS_PATH_ENV,
  WINDOWS_PATHEXT_ENV,
  WINDOWS_SHELL_SCRIPT_EXTENSIONS,
} from '../constants.js';

export interface ResolveLaunchDeps {
  platform: NodeJS.Platform;
  /** The env the PTY will receive, so PATH, PATHEXT and ComSpec are read from
   *  what the child would see rather than from the server's own process.env. */
  env: Readonly<Record<string, string>>;
  /** Whether `filePath` is an existing regular file. */
  isFile: (filePath: string) => boolean;
}

export interface ResolvedLaunch {
  /** Program handed to the PTY module's spawn(). */
  file: string;
  /** argv -- or, when the launch goes through cmd.exe, the pre-escaped
   *  command-line tail as ONE string. node-pty passes a string through
   *  verbatim on Windows; an array is re-quoted, which escapes the inner
   *  quotes cmd.exe needs around a script path containing spaces. */
  args: string[] | string;
}

/**
 * Resolve `command` for spawning. Returns null when, on Windows, nothing on
 * PATH matches; the caller decides how to fail (the PTY module's own error
 * remains the behaviour there).
 */
export function resolveLaunchCommand(
  command: string,
  args: readonly string[],
  deps: ResolveLaunchDeps,
): ResolvedLaunch | null {
  if (deps.platform !== 'win32') return { file: command, args: [...args] };

  // A command that names a location (absolute, or with a directory part) is
  // the caller's choice: used as given, no PATH search.
  const file = hasDirectory(command) ? command : findOnPath(command, deps);
  if (file === null) return null;

  if (!isShellScript(file)) return { file, args: [...args] };

  const comSpec = envValue(deps.env, WINDOWS_COMSPEC_ENV) || WINDOWS_DEFAULT_COMSPEC;
  const commandLine = [file, ...args].map(quoteForCmd).join(' ');
  return { file: comSpec, args: `${WINDOWS_CMD_FLAGS.join(' ')} "${commandLine}"` };
}

function hasDirectory(command: string): boolean {
  return path.win32.isAbsolute(command) || /[\/]/.test(command);
}

function findOnPath(command: string, deps: ResolveLaunchDeps): string | null {
  const names = candidateNames(command, pathExtensions(deps.env));
  for (const dir of pathDirectories(deps.env)) {
    for (const name of names) {
      const candidate = path.win32.join(dir, name);
      if (deps.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** cmd.exe's rule: a name is tried with each PATHEXT extension appended, and a
 *  name that already carries an extension is tried as given first. A bare
 *  extensionless file is never a candidate -- CreateProcess cannot run one, so
 *  matching it (a POSIX script beside claude.exe, say) would only move the
 *  failure later. */
function candidateNames(command: string, extensions: readonly string[]): string[] {
  const withExtension = extensions.map((ext) => command + ext);
  return path.win32.extname(command) === '' ? withExtension : [command, ...withExtension];
}

function pathDirectories(env: Readonly<Record<string, string>>): string[] {
  return (envValue(env, WINDOWS_PATH_ENV) ?? '')
    .split(path.win32.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '');
}

function pathExtensions(env: Readonly<Record<string, string>>): readonly string[] {
  const extensions = (envValue(env, WINDOWS_PATHEXT_ENV) ?? '')
    .split(path.win32.delimiter)
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '');
  return extensions.length > 0 ? extensions : WINDOWS_DEFAULT_PATHEXT;
}

function isShellScript(file: string): boolean {
  const extension = path.win32.extname(file).toLowerCase();
  return (WINDOWS_SHELL_SCRIPT_EXTENSIONS as readonly string[]).includes(extension);
}

/** Case-insensitive lookup: Node makes process.env itself case-insensitive on
 *  Windows, but a plain object copied from it keeps the host's spelling
 *  (`Path`, `PATHEXT`, `ComSpec` on most installs). */
function envValue(env: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : env[key];
}

/** cmd.exe quoting: wrap a token that is empty or contains whitespace. No
 *  escape exists for an embedded quote that both cmd.exe and the program
 *  behind the shim honour, so none is attempted -- launch args are flags and
 *  ids. */
function quoteForCmd(token: string): string {
  return token === '' || /\s/.test(token) ? `"${token}"` : token;
}
