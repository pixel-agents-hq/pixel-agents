import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getExternalNarrationLogPath } from './external-monitor';
import { waitForHookServer } from './hooks';
import { narrate } from './test-narration';

const DEFAULT_HOLD_OPEN_MS = 30_000;
const HOOK_SETUP_TIMEOUT_MS = 20_000;
const INVOCATION_TIMEOUT_MS = 20_000;
const SCENARIO_SCHEMA_VERSION = 1;

export interface ClaudeMockSessionDefinition {
  alias: string;
  sessionIdTemplate: string;
  cwdTemplate?: string;
  transcriptPathTemplate?: string;
  sidecarPathTemplate?: string;
  sidecarJson?: Record<string, unknown>;
}

export interface ClaudeMockAppendJsonlAction {
  kind: 'appendJsonl';
  atMs: number;
  session: string;
  record: Record<string, unknown>;
}

export interface ClaudeMockEmitHookAction {
  kind: 'emitHook';
  atMs: number;
  payload: Record<string, unknown>;
}

export interface ClaudeMockWriteJsonAction {
  kind: 'writeJson';
  atMs: number;
  filePath: string;
  value: Record<string, unknown>;
}

export interface ClaudeMockDeletePathAction {
  kind: 'deletePath';
  atMs: number;
  filePath: string;
}

export interface ClaudeMockExitAction {
  kind: 'exit';
  atMs: number;
  code?: number;
}

export type ClaudeMockAction =
  | ClaudeMockAppendJsonlAction
  | ClaudeMockEmitHookAction
  | ClaudeMockWriteJsonAction
  | ClaudeMockDeletePathAction
  | ClaudeMockExitAction;

export interface ClaudeMockScenario {
  schemaVersion: number;
  name?: string;
  autoInit: boolean;
  holdOpenMs: number;
  sessions: ClaudeMockSessionDefinition[];
  actions: ClaudeMockAction[];
}

class TimedScenarioStepBuilder {
  constructor(
    private readonly scenario: ClaudeMockScenarioBuilder,
    private readonly atMs: number,
  ) {}

  appendJsonl(
    record: Record<string, unknown>,
    options?: { session?: string },
  ): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'appendJsonl',
      atMs: this.atMs,
      session: options?.session ?? 'self',
      record,
    });
    return this.scenario;
  }

  emitHook(payload: Record<string, unknown>): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'emitHook',
      atMs: this.atMs,
      payload,
    });
    return this.scenario;
  }

  writeJson(filePath: string, value: Record<string, unknown>): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'writeJson',
      atMs: this.atMs,
      filePath,
      value,
    });
    return this.scenario;
  }

  deletePath(filePath: string): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'deletePath',
      atMs: this.atMs,
      filePath,
    });
    return this.scenario;
  }

  exit(code = 0): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'exit',
      atMs: this.atMs,
      code,
    });
    return this.scenario;
  }
}

export class ClaudeMockScenarioBuilder {
  private autoInit = true;
  private holdOpenMs = DEFAULT_HOLD_OPEN_MS;
  private readonly sessions: ClaudeMockSessionDefinition[] = [];
  private readonly actions: ClaudeMockAction[] = [];

  constructor(private readonly name?: string) {}

  defineSession(
    alias: string,
    sessionIdTemplate: string,
    options?: {
      cwdTemplate?: string;
      transcriptPathTemplate?: string;
      sidecarPathTemplate?: string;
      sidecarJson?: Record<string, unknown>;
    },
  ): ClaudeMockScenarioBuilder {
    this.sessions.push({
      alias,
      sessionIdTemplate,
      cwdTemplate: options?.cwdTemplate,
      transcriptPathTemplate: options?.transcriptPathTemplate,
      sidecarPathTemplate: options?.sidecarPathTemplate,
      sidecarJson: options?.sidecarJson,
    });
    return this;
  }

  withoutAutoInit(): ClaudeMockScenarioBuilder {
    this.autoInit = false;
    return this;
  }

  holdOpenFor(ms: number): ClaudeMockScenarioBuilder {
    this.holdOpenMs = ms;
    return this;
  }

  at(ms: number): TimedScenarioStepBuilder {
    return new TimedScenarioStepBuilder(this, ms);
  }

  exitAt(ms: number, code = 0): ClaudeMockScenarioBuilder {
    this.pushAction({
      kind: 'exit',
      atMs: ms,
      code,
    });
    return this;
  }

  pushAction(action: ClaudeMockAction): void {
    this.actions.push(action);
  }

  build(): ClaudeMockScenario {
    return {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      name: this.name,
      autoInit: this.autoInit,
      holdOpenMs: this.holdOpenMs,
      sessions: [...this.sessions],
      actions: [...this.actions].sort((left, right) => left.atMs - right.atMs),
    };
  }
}

export function claudeScenario(name?: string): ClaudeMockScenarioBuilder {
  return new ClaudeMockScenarioBuilder(name);
}

export function mockClaudeInitRecord(content = 'mock-claude-ready'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    content,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMockRoot(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock');
}

function getScenarioQueuePath(tmpHome: string): string {
  return path.join(getMockRoot(tmpHome), 'scenario-queue.json');
}

function readScenarioQueue(tmpHome: string): ClaudeMockScenario[] {
  const queuePath = getScenarioQueuePath(tmpHome);
  try {
    const raw = fs.readFileSync(queuePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ClaudeMockScenario[]) : [];
  } catch {
    return [];
  }
}

function writeScenarioQueue(tmpHome: string, queue: ClaudeMockScenario[]): void {
  const queuePath = getScenarioQueuePath(tmpHome);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hooksInstalledInSettings(settingsPath: string): boolean {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const hooks = parsed.hooks;
    return Boolean(
      hooks &&
      Array.isArray(hooks['SessionStart']) &&
      Array.isArray(hooks['PreToolUse']) &&
      Array.isArray(hooks['SessionEnd']),
    );
  } catch {
    return false;
  }
}

export async function waitForClaudeHookSetup(tmpHome: string): Promise<void> {
  await waitForHookServer(tmpHome);

  const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
  const hookScriptPath = path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js');
  const deadline = Date.now() + HOOK_SETUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (fs.existsSync(hookScriptPath) && hooksInstalledInSettings(settingsPath)) {
      return;
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for Claude hook setup at ${settingsPath} and ${hookScriptPath}`,
  );
}

export async function arrangeNextClaudeInvocation(
  tmpHome: string,
  scenario: ClaudeMockScenario,
): Promise<void> {
  const queue = readScenarioQueue(tmpHome);
  queue.push(scenario);
  writeScenarioQueue(tmpHome, queue);
}

function getMockClaudeBinaryPath(tmpHome: string): string {
  const binDir = path.resolve(tmpHome, '..', 'bin');
  return path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
}

/**
 * Point a child process's home at the isolated test home on every platform.
 *
 * macOS/Linux: Node's os.homedir() honors $HOME, so setting HOME is enough.
 * Windows: os.homedir() reads USERPROFILE and IGNORES $HOME. The mock claude
 * runner (and the extension) resolve ~/.claude via os.homedir(), so without
 * USERPROFILE they read/write the REAL user profile while the test asserts on
 * tmpHome — every external-spawn test times out on Windows only. Set both, and
 * clear the legacy HOMEDRIVE/HOMEPATH fallbacks libuv consults when USERPROFILE
 * is unset so a stale host value can't win.
 */
export function applyMockHomeEnv(base: NodeJS.ProcessEnv, tmpHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: tmpHome };
  if (process.platform === 'win32') {
    env.USERPROFILE = tmpHome;
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
  }
  return env;
}

export interface ExternalClaudeSpawn {
  process: ChildProcess;
  sessionId: string;
}

/** Module-level registry of external mock-claude processes so fixture teardown
 *  can kill any that the test forgot to clean up. Suite runs with workers: 1,
 *  so cross-test contamination is impossible. */
const trackedExternalProcesses = new Set<ChildProcess>();

/** Kill any mock-claude processes spawned via spawnExternalClaudeScenario
 *  that are still alive. Called from the test fixture's teardown. */
export async function killTrackedExternalProcesses(): Promise<void> {
  for (const child of trackedExternalProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may already be gone; ignore.
      }
    }
  }
  trackedExternalProcesses.clear();
}

export async function spawnExternalClaudeScenario(options: {
  tmpHome: string;
  workspaceDir: string;
  mockLogFile: string;
  scenario: ClaudeMockScenario;
  sessionId: string;
}): Promise<ExternalClaudeSpawn> {
  // Universal narration moment (cosmetic): every external spawn is a detached
  // session Pixel Agents adopts rather than launches. Its own magenta stdout
  // narrates the per-hook timeline in the monitor tab.
  narrate.step('spawning a detached external mock session (adopted, not launched)');
  await arrangeNextClaudeInvocation(options.tmpHome, options.scenario);

  const claudeBinary = getMockClaudeBinaryPath(options.tmpHome);
  const env = {
    ...applyMockHomeEnv(process.env, options.tmpHome),
    PATH: `${path.dirname(claudeBinary)}${path.delimiter}${process.env['PATH'] ?? ''}`,
    PIXEL_AGENTS_NODE_BIN: process.execPath,
    // Switches the runner's narration to the magenta [external·tag] style.
    PIXEL_AGENTS_MOCK_EXTERNAL: '1',
  };

  // Pipe stderr so we can surface diagnostics on timeout. stdout (the mock's
  // step-by-step narration) appends to the per-test external-narration log,
  // which the monitor terminal opened below tails inside the recorded window.
  const narrationLog = getExternalNarrationLogPath(options.tmpHome);
  fs.mkdirSync(path.dirname(narrationLog), { recursive: true });
  const narrationFd = fs.openSync(narrationLog, 'a');
  const child = spawn(claudeBinary, ['--session-id', options.sessionId], {
    cwd: options.workspaceDir,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', narrationFd, 'pipe'],
  });
  fs.closeSync(narrationFd);

  // Track this child so fixture teardown can SIGTERM it if the test forgot to.
  trackedExternalProcesses.add(child);
  child.on('exit', () => trackedExternalProcesses.delete(child));

  // Capture stderr + early exit so timeouts can blame the actual cause. Use a
  // ref object so TypeScript narrows correctly through the async event-loop boundary
  // (TS doesn't track let-bindings mutated in callbacks the same way it tracks
  // property writes; the closure-narrowing limitation collapses spawnError to never).
  const watch: {
    stderrChunks: Buffer[];
    spawnError: Error | null;
    earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  } = {
    stderrChunks: [],
    spawnError: null,
    earlyExit: null,
  };
  child.stderr?.on('data', (chunk: Buffer) => watch.stderrChunks.push(chunk));
  child.on('error', (err) => {
    watch.spawnError = err;
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 || signal !== null) {
      watch.earlyExit = { code, signal };
    }
  });

  const deadline = Date.now() + INVOCATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (watch.spawnError) {
      throw new Error(
        `External mock Claude session ${options.sessionId} failed to spawn: ${watch.spawnError.message}`,
      );
    }
    const invocationLog = readTextIfExists(options.mockLogFile);
    if (invocationLog.includes(`session-id=${options.sessionId}`)) {
      return {
        process: child,
        sessionId: options.sessionId,
      };
    }
    if (watch.earlyExit) {
      const stderrText = Buffer.concat(watch.stderrChunks).toString('utf8').trim();
      throw new Error(
        `External mock Claude session ${options.sessionId} exited early ` +
          `(code=${watch.earlyExit.code}, signal=${watch.earlyExit.signal}) before logging an invocation. ` +
          `stderr: ${stderrText || '<empty>'}`,
      );
    }
    await sleep(250);
  }

  const stderrText = Buffer.concat(watch.stderrChunks).toString('utf8').trim();
  throw new Error(
    `Timed out waiting for external mock Claude session ${options.sessionId}. ` +
      `stderr so far: ${stderrText || '<empty>'}`,
  );
}
