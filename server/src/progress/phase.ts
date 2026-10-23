/**
 * Work-phase rules for the stage track (EXPLORE · BUILD · TEST · SHIP) and the
 * shell-command predicates behind the done-today totals. Pure: no state, no I/O.
 *
 * Shell commands are read the way a person skims them, not parsed: the command
 * line is split into simple commands at unquoted separators (`;`, `&&`, `||`,
 * `|`, newlines, and the brackets of PowerShell's `if ($?) { … }`), each simple
 * command loses its prefixes (env assignments, `sudo`, `npx`, `uv run`, …), and
 * the program name plus its first arguments decide. Quoted text is one word, so
 * `echo "npm test"` or a commit message that mentions tests runs nothing.
 */

import type { WorkPhase } from '../../../core/src/messages.js';

const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'LS',
]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/** The phase a tool use puts its agent in, or null for tools that leave it unchanged. */
export function classifyTool(toolName: string, input: Record<string, unknown>): WorkPhase | null {
  if (EXPLORE_TOOLS.has(toolName)) return 'explore';
  if (EDIT_TOOLS.has(toolName)) return 'build';
  const command = shellCommandOf(toolName, input);
  if (command === undefined) return null;
  // A chain that ships is shipping, whatever it tested on the way.
  if (isShipCommand(command)) return 'ship';
  if (isTestCommand(command)) return 'test';
  return null;
}

/** Bash and PowerShell: the tools whose every start is a command run. */
export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

/** The command a shell tool runs, or undefined for any other tool. */
export function shellCommandOf(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!SHELL_TOOLS.has(toolName)) return undefined;
  return typeof input.command === 'string' ? input.command : '';
}

/** The file an editing tool writes (`file_path`, or `notebook_path` for NotebookEdit). */
export function editedFileOf(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!EDIT_TOOLS.has(toolName)) return undefined;
  const file = input.file_path ?? input.notebook_path;
  return typeof file === 'string' && file ? file : undefined;
}

// ── Command line → simple commands ───────────────────────────

interface SimpleCommand {
  /** Program name: basename, lower case, without .cmd/.exe/.ps1/.bat. */
  name: string;
  /** Arguments as written (quotes removed). */
  args: string[];
  /** The same arguments in lower case, for matching (PowerShell ignores case). */
  lower: string[];
}

/** Words of each simple command. Separators only count outside quotes; a
 *  backslash escapes only inside double quotes, so Windows paths survive. */
function splitCommandLine(cmd: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (quote === '"' && c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
        word += cmd[++i];
      } else {
        word += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\n' || ';&|(){}'.includes(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** Words that run the next word instead of being the program. */
const PREFIX_WORDS: ReadonlySet<string> = new Set([
  'sudo',
  'time',
  'env',
  'nice',
  'nohup',
  'command',
  'exec',
  'builtin',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  'call',
]);
/** Runners whose first non-flag argument is the program they run. */
const RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx']);
/** Package managers and project tools whose `exec`/`run`/`dlx` subcommand runs a program. */
const RUNNER_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['exec']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
  uv: new Set(['run']),
  poetry: new Set(['run']),
  pipenv: new Set(['run']),
};
const PYTHONS: ReadonlySet<string> = new Set(['python', 'python3', 'py']);
/** Shells whose inline script (`bash -c "…"`, `pwsh -Command …`, `cmd /c …`) is the real command. */
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd']);
/** Nesting limit for shell-in-shell scripts. */
const MAX_SHELL_DEPTH = 3;

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, '');
}

function makeCommand(name: string, args: string[]): SimpleCommand {
  return { name, args, lower: args.map((a) => a.toLowerCase()) };
}

/** Strip prefixes and runners down to the program actually run. */
function normalize(words: string[]): SimpleCommand | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const lw = w.toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_WORDS.has(lw) || w.startsWith('$')) {
      i++;
    } else if (lw === 'timeout') {
      i++;
      while (i < words.length && /^(-|\d)/.test(words[i])) i++;
    } else {
      break;
    }
  }
  if (i >= words.length) return null;

  const name = programName(words[i]);
  const rest = words.slice(i + 1);
  if (RUNNERS.has(name)) {
    const at = rest.findIndex((a) => !a.startsWith('-'));
    return at < 0 ? null : normalize(rest.slice(at));
  }
  const runnerSub = RUNNER_SUBCOMMANDS[name];
  if (runnerSub && rest.length > 0 && runnerSub.has(rest[0].toLowerCase())) {
    const at = rest.findIndex((a, k) => k > 0 && !a.startsWith('-'));
    return at < 0 ? null : normalize(rest.slice(at));
  }
  if (PYTHONS.has(name)) {
    const m = rest.indexOf('-m');
    if (m >= 0 && m + 1 < rest.length) {
      return makeCommand(programName(rest[m + 1]), rest.slice(m + 2));
    }
  }
  return makeCommand(name, rest);
}

/** The inline script a shell is asked to run, if it is running one. */
function shellScriptOf(c: SimpleCommand): string | undefined {
  const at = c.lower.findIndex((a) =>
    c.name === 'cmd'
      ? a === '/c' || a === '/k'
      : c.name === 'powershell' || c.name === 'pwsh'
        ? a === '-c' || a === '-command'
        : /^-[a-z]*c$/.test(a),
  );
  return at >= 0 && at + 1 < c.args.length ? c.args.slice(at + 1).join(' ') : undefined;
}

function* simpleCommands(cmd: string, depth = 0): Generator<SimpleCommand> {
  for (const words of splitCommandLine(cmd)) {
    const c = normalize(words);
    if (!c) continue;
    const script = SHELLS.has(c.name) && depth < MAX_SHELL_DEPTH ? shellScriptOf(c) : undefined;
    if (script !== undefined) {
      yield* simpleCommands(script, depth + 1);
    } else {
      yield c;
    }
  }
}

function anyCommand(cmd: string, test: (c: SimpleCommand) => boolean): boolean {
  for (const c of simpleCommands(cmd)) {
    if (test(c)) return true;
  }
  return false;
}

/** Flags that take the next word as their value (`npm -w server test`, `git -C dir push`). */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-w',
  '--workspace',
  '--prefix',
  '--filter',
  '--dir',
  '--cwd',
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '-R',
  '--repo',
]);

/** Arguments that are not flags or flag values, in order. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function hasFlag(c: SimpleCommand, ...flags: string[]): boolean {
  return c.lower.some((a) => flags.includes(a));
}

// ── Test / check / build ─────────────────────────────────────

/** Programs that only ever test, type-check, lint or build. */
const CHECK_PROGRAMS: ReadonlySet<string> = new Set([
  'vitest',
  'jest',
  'pytest',
  'py.test',
  'mocha',
  'ava',
  'karma',
  'tsc',
  'vue-tsc',
  'eslint',
  'stylelint',
  'playwright',
  'cypress',
  'rspec',
  'phpunit',
  'mypy',
  'pyright',
  'flake8',
  'pylint',
  'ruff',
  'golangci-lint',
  'tox',
  'nox',
  'unittest',
  'ctest',
]);
/** Words that make a package script or a build-tool subcommand a check. */
const CHECK_WORDS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  'spec',
  'lint',
  'eslint',
  'build',
  'check',
  'typecheck',
  'tsc',
  'e2e',
  'compile',
  'verify',
  'vet',
  'clippy',
  'vitest',
  'jest',
  'playwright',
]);
/** Tools whose first positional argument is a subcommand (`cargo test`, `go vet`). */
const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set([
  'cargo',
  'go',
  'dotnet',
  'swift',
  'deno',
  'zig',
  'mix',
  'flutter',
  'dart',
  'docker',
  'vite',
  'next',
  'bazel',
  'bazelisk',
  'sbt',
  'stack',
  'cabal',
]);
/** Tools that take several goals, any of which may be a check (`mvn clean test`). */
const GOAL_TOOLS: ReadonlySet<string> = new Set(['make', 'mvn', 'mvnw', 'gradle', 'gradlew']);
/** Monorepo runners: `turbo run build`, `nx run web:test`, `nx test web`. */
const TASK_RUNNERS: ReadonlySet<string> = new Set(['turbo', 'nx']);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** `test:server`, `check-types`, `build`: any part of the script name is a check word. */
function isCheckScript(script: string | undefined): boolean {
  if (!script) return false;
  return script
    .toLowerCase()
    .split(/[:\-_./]+/)
    .some((part) => CHECK_WORDS.has(part));
}

function isCheckCommand(c: SimpleCommand): boolean {
  if (CHECK_PROGRAMS.has(c.name)) return true;
  const pos = positionals(c.args);
  if (PACKAGE_MANAGERS.has(c.name)) {
    const sub = pos[0]?.toLowerCase();
    if (sub === 'test' || sub === 't' || sub === 'tst') return true;
    if (sub === 'run' || sub === 'run-script') return isCheckScript(pos[1]);
    // `yarn workspace web build`
    if (sub === 'workspace' && c.name === 'yarn') return isCheckScript(pos[2]);
    // npm's other subcommands are its own (install, ci, …); the rest run scripts directly.
    return c.name !== 'npm' && isCheckScript(sub);
  }
  if (TASK_RUNNERS.has(c.name)) {
    return pos[0]?.toLowerCase() === 'run' ? isCheckScript(pos[1]) : isCheckScript(pos[0]);
  }
  if (SUBCOMMAND_TOOLS.has(c.name)) {
    return pos.length > 0 && CHECK_WORDS.has(pos[0].toLowerCase());
  }
  if (GOAL_TOOLS.has(c.name)) {
    // A bare `make` builds the default target.
    return (c.name === 'make' && pos.length === 0) || pos.some((goal) => isCheckScript(goal));
  }
  if (c.name === 'node') return hasFlag(c, '--test');
  return false;
}

/** Does this command run tests, type checks, lints or a build? */
export function isTestCommand(cmd: string): boolean {
  return anyCommand(cmd, isCheckCommand);
}

// ── Ship ─────────────────────────────────────────────────────

function gitSubcommand(c: SimpleCommand): string | undefined {
  return c.name === 'git' ? positionals(c.args)[0]?.toLowerCase() : undefined;
}

function isGitCommit(c: SimpleCommand): boolean {
  return gitSubcommand(c) === 'commit' && !hasFlag(c, '--dry-run', '--help', '-h');
}

function isGitPush(c: SimpleCommand): boolean {
  return gitSubcommand(c) === 'push' && !hasFlag(c, '--dry-run', '-n', '--help', '-h');
}

function ghPrAction(c: SimpleCommand): string | undefined {
  if (c.name !== 'gh' || hasFlag(c, '--help', '-h')) return undefined;
  const pos = positionals(c.args).map((a) => a.toLowerCase());
  return pos[0] === 'pr' ? pos[1] : undefined;
}

function isGhPrCreate(c: SimpleCommand): boolean {
  // --web only opens the browser form and --dry-run prints it: no PR yet.
  return ghPrAction(c) === 'create' && !hasFlag(c, '--web', '-w', '--dry-run');
}

function isShip(c: SimpleCommand): boolean {
  if (isGitCommit(c) || isGitPush(c)) return true;
  const action = ghPrAction(c);
  // Opening the PR form in the browser is shipping too; it just isn't a PR yet.
  return (action === 'create' && !hasFlag(c, '--dry-run')) || action === 'merge';
}

/** Does this command commit, push, open a PR or merge one? */
export function isShipCommand(cmd: string): boolean {
  return anyCommand(cmd, isShip);
}

/** Does this command `git push`? */
export function isPushCommand(cmd: string): boolean {
  return anyCommand(cmd, isGitPush);
}

/** Does this command open a pull request (`gh pr create`)? */
export function isPrCreateCommand(cmd: string): boolean {
  return anyCommand(cmd, isGhPrCreate);
}

/** The `--title`/`-t` a `gh pr create` passes (`--title "x"`, `--title 'x'`, `--title=x`, `-t "x"`). */
export function prTitleFromCommand(cmd: string): string | undefined {
  for (const c of simpleCommands(cmd)) {
    if (!isGhPrCreate(c)) continue;
    for (let i = 0; i < c.args.length; i++) {
      const a = c.args[i];
      let title: string | undefined;
      if ((a === '--title' || a === '-t') && i + 1 < c.args.length) {
        title = c.args[i + 1];
      } else if (a.startsWith('--title=')) {
        title = a.slice('--title='.length);
      }
      if (title?.trim()) return hasShellExpansion(title) ? undefined : title.trim();
    }
  }
  return undefined;
}

/** `$var`, `${…}`, `$(…)`, a backtick, or PowerShell's `$env:X`: the hook sees
 *  the command before the shell expands it, so the text isn't the real title.
 *  A `$` before a digit (a price) is literal. */
function hasShellExpansion(text: string): boolean {
  return /\$[A-Za-z_{(]|`/.test(text);
}

// ── Pull request urls ────────────────────────────────────────

const GITHUB_PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/;

/** The first `https://github.com/<owner>/<repo>/pull/<n>` in the text. */
export function findPrUrl(text: string | undefined): string | undefined {
  return text?.match(GITHUB_PR_URL)?.[0];
}

/** `<owner>/<repo>` of a GitHub PR url. */
export function repoFromPrUrl(url: string): string | undefined {
  const m = url.match(GITHUB_PR_URL);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
