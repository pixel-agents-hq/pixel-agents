#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_HOLD_OPEN_MS = 30_000;
const SCENARIO_SCHEMA_VERSION = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSessionId(argv) {
  let previous = '';
  for (const arg of argv) {
    // A fresh session names its id; a resumed one names the one it resumes.
    if (previous === '--session-id' || previous === '--resume') {
      return arg;
    }
    previous = arg;
  }
  return '';
}

/** The value after `flag` in argv (`--mcp-config <file>`), or ''. */
function argAfter(argv, flag) {
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : '';
}

/** The starting prompt: what follows `--` (the CLI's positional prompt). */
function parsePrompt(argv) {
  const at = argv.indexOf('--');
  return at >= 0 ? argv.slice(at + 1).join(' ') : '';
}

function claudeProjectDirName(workspacePath) {
  return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function getMockRoot(homeDir) {
  return path.join(homeDir, '.claude-mock');
}

function getScenarioQueuePath(homeDir) {
  return path.join(getMockRoot(homeDir), 'scenario-queue.json');
}

function readScenarioQueue(homeDir) {
  try {
    const raw = fs.readFileSync(getScenarioQueuePath(homeDir), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeScenarioQueue(homeDir, queue) {
  const queuePath = getScenarioQueuePath(homeDir);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function claimScenario(homeDir) {
  const queue = readScenarioQueue(homeDir);
  if (queue.length === 0) {
    return null;
  }

  const [scenario, ...rest] = queue;
  writeScenarioQueue(homeDir, rest);
  return scenario;
}

function logLine(homeDir, fileName, line) {
  const logDir = getMockRoot(homeDir);
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, fileName), `${line}\n`);
}

function logInvocation(homeDir, sessionId, cwd, args) {
  logLine(
    homeDir,
    'invocations.log',
    `${new Date().toISOString()} session-id=${sessionId} cwd=${cwd} args=${args.join(' ')}`,
  );
  // The argv exactly (an argument may hold spaces: a first message).
  logLine(homeDir, 'argv.log', JSON.stringify({ sessionId, cwd, args }));
}

function logAction(homeDir, message) {
  logLine(homeDir, 'actions.log', `${new Date().toISOString()} ${message}`);
}

const ANSI_DIM = '\u001b[2m';
const ANSI_CYAN = '\u001b[36m';
const ANSI_YELLOW = '\u001b[33m';
const ANSI_MAGENTA = '\u001b[35m';
const ANSI_RESET = '\u001b[0m';

// External sessions (spawned detached by the e2e harness so Pixel Agents
// ADOPTS them instead of launching them) narrate into a shared per-test log
// that a monitor terminal tails. The magenta prefix keeps their lines
// visually distinct from internal-terminal narration, and the short
// per-session tag keeps interleaved external sessions tellable apart.
const IS_EXTERNAL = process.env.PIXEL_AGENTS_MOCK_EXTERNAL === '1';
let externalTag = '';

function tinySessionTag(value) {
  let hash = 0;
  for (const ch of String(value)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36).slice(0, 4);
}

function shortId(value) {
  const str = String(value);
  return str.length > 24 ? `${str.slice(0, 8)}…${str.slice(-8)}` : str;
}

/**
 * Human-readable narration to stdout. Pixel Agents never reads the terminal
 * (its inputs are JSONL transcripts and hook POSTs), so this changes nothing
 * about what tests exercise — it exists purely so run recordings show WHAT
 * the mock is simulating and WHEN, where real claude would render its TUI.
 */
function echo(atMs, message) {
  const stamp = typeof atMs === 'number' ? `t+${(atMs / 1000).toFixed(1)}s`.padStart(7) : '       ';
  const prefix = IS_EXTERNAL
    ? `${ANSI_MAGENTA}[external·${externalTag}]${ANSI_DIM}${stamp}${ANSI_RESET}`
    : `${ANSI_DIM}[mock-claude]${stamp}${ANSI_RESET}`;
  process.stdout.write(`${prefix} ${message}\n`);
}

function describeJsonlRecord(record) {
  if (!record || typeof record !== 'object') return 'record';
  const type = [record.type, record.subtype].filter(Boolean).join('/');
  const content =
    record.message && Array.isArray(record.message.content) ? record.message.content : [];
  const tools = content
    .filter((part) => part && part.type === 'tool_use')
    .map((part) => part.name)
    .filter(Boolean);
  const resultCount = content.filter((part) => part && part.type === 'tool_result').length;
  if (tools.length > 0) return `${type} tool_use ${tools.join(', ')}`;
  if (resultCount > 0) return `${type} tool_result x${resultCount}`;
  return type || 'record';
}

function describeHookPayload(payload) {
  const parts = [String(payload.hook_event_name)];
  if (payload.tool_name) parts.push(String(payload.tool_name));
  const command = payload.tool_input && payload.tool_input.command;
  if (command) parts.push(`"${String(command).slice(0, 40)}"`);
  const target =
    payload.tool_input &&
    (payload.tool_input.file_path || payload.tool_input.pattern || payload.tool_input.url);
  if (target) parts.push(String(target).slice(0, 40));
  if (payload.source) parts.push(`source=${payload.source}`);
  if (payload.reason) parts.push(`reason=${payload.reason}`);
  if (payload.session_id) parts.push(`→ ${shortId(payload.session_id)}`);
  return parts.join(' ');
}

function ensureSessionContext(homeDir, sessionId, cwd) {
  const projectDir = path.join(homeDir, '.claude', 'projects', claudeProjectDirName(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    sessionId,
    cwd,
    projectDir,
    transcriptPath: path.join(projectDir, `${sessionId}.jsonl`),
  };
}

function ensureSessionContextWithTranscript(homeDir, sessionId, cwd, transcriptPath) {
  const context = ensureSessionContext(homeDir, sessionId, cwd);
  if (!transcriptPath) {
    return context;
  }
  return {
    ...context,
    transcriptPath,
  };
}

function ensureTranscriptExists(transcriptPath) {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  if (!fs.existsSync(transcriptPath)) {
    fs.writeFileSync(transcriptPath, '');
  }
}

function appendJsonl(transcriptPath, record) {
  ensureTranscriptExists(transcriptPath);
  fs.appendFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** A scenario's deletePath: only ever something inside the temp dir (the test's own home). */
function deletePathTarget(filePath) {
  const tmp = fs.realpathSync(os.tmpdir());
  const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : path.resolve(filePath);
  const rel = path.relative(tmp, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`deletePath: refusing ${filePath} (not inside ${tmp})`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function readSettings(homeDir) {
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizePathForMatch(value) {
  return String(value).replace(/\\/g, '/');
}

function isPixelAgentsHookCommand(homeDir, command) {
  if (typeof command !== 'string' || command.length === 0) {
    return false;
  }

  const normalizedCommand = normalizePathForMatch(command);
  const currentHookPath = normalizePathForMatch(
    path.join(homeDir, '.pixel-agents', 'hooks', 'claude-hook.js'),
  );

  return normalizedCommand.includes(currentHookPath);
}

function resolveTemplateString(template, context) {
  if (typeof template !== 'string') {
    return template;
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawKey) => {
    const value = lookupPath(context, rawKey);
    return value === undefined || value === null ? '' : String(value);
  });
}

/** The value at a dotted `{{path}}` in the context (undefined when absent). */
function lookupPath(context, rawKey) {
  return rawKey
    .trim()
    .split('.')
    .reduce(
      (accumulator, segment) =>
        accumulator && Object.prototype.hasOwnProperty.call(accumulator, segment)
          ? accumulator[segment]
          : undefined,
      context,
    );
}

function resolveValue(value, context) {
  if (typeof value === 'string') {
    return resolveTemplateString(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, context));
  }

  if (value && typeof value === 'object') {
    const resolved = {};
    for (const [key, nested] of Object.entries(value)) {
      resolved[key] = resolveValue(nested, context);
    }
    return resolved;
  }

  return value;
}

function buildContext(homeDir, scenario, sessionId, cwd, mcpConfigPath) {
  const self = ensureSessionContextWithTranscript(homeDir, sessionId, cwd);
  const context = {
    mcpConfigPath,
    // Results of callOfficeMcp actions, by their saveAs name.
    mcp: {},
    sessionId: self.sessionId,
    cwd: self.cwd,
    projectDir: self.projectDir,
    transcriptPath: self.transcriptPath,
    sessions: {
      self: {
        sessionId: self.sessionId,
        cwd: self.cwd,
        projectDir: self.projectDir,
        transcriptPath: self.transcriptPath,
      },
    },
  };

  for (const sessionDefinition of scenario.sessions || []) {
    const resolvedSessionId = resolveTemplateString(sessionDefinition.sessionIdTemplate, context);
    const resolvedCwd = resolveTemplateString(sessionDefinition.cwdTemplate || '{{cwd}}', context);
    const resolvedTranscriptPath = sessionDefinition.transcriptPathTemplate
      ? resolveTemplateString(sessionDefinition.transcriptPathTemplate, context)
      : undefined;
    const sessionContext = ensureSessionContextWithTranscript(
      homeDir,
      resolvedSessionId,
      resolvedCwd,
      resolvedTranscriptPath,
    );
    const resolvedSidecarPath = sessionDefinition.sidecarPathTemplate
      ? resolveTemplateString(sessionDefinition.sidecarPathTemplate, {
          ...context,
          sessions: {
            ...context.sessions,
            [sessionDefinition.alias]: sessionContext,
          },
        })
      : undefined;
    const resolvedSidecarJson = sessionDefinition.sidecarJson
      ? resolveValue(sessionDefinition.sidecarJson, {
          ...context,
          sessions: {
            ...context.sessions,
            [sessionDefinition.alias]: sessionContext,
          },
        })
      : undefined;

    context.sessions[sessionDefinition.alias] = {
      ...sessionContext,
      sidecarPath: resolvedSidecarPath,
      sidecarJson: resolvedSidecarJson,
    };
  }

  return context;
}

function runHookCommand(command, payload, env, cwd) {
  // The hook command in settings.json is `node "<script>"` (bare `node`). On
  // macOS the VS Code integrated-terminal e2e profile sets a hardcoded PATH
  // (mockBin:/usr/local/bin:/usr/bin:/bin) with inheritEnv:false, which on CI
  // runners does NOT include the toolcache node dir — so bare `node` exits 127
  // and the hook never POSTs. The mock itself survives because its wrapper uses
  // the absolute PIXEL_AGENTS_NODE_BIN, but the spawned hook uses bare `node`.
  // Prepend the running node's bin dir to PATH so the hook resolves it, on any
  // spawn path. (Real Claude Code spawns hooks with the user's real PATH, so
  // this is purely a test-harness fix.)
  const nodeDir = path.dirname(process.execPath);
  const sep = process.platform === 'win32' ? ';' : ':';
  const hookEnv = {
    ...env,
    PATH: `${nodeDir}${sep}${env.PATH ?? ''}`,
    Path: `${nodeDir}${sep}${env.Path ?? env.PATH ?? ''}`,
  };
  // Resolves with diagnostic info so emitHook can log whether the spawned
  // hook script actually ran and how it exited (CI macOS investigation).
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: hookEnv,
      shell: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    child.on('error', (err) => resolve({ spawned: false, error: err.message }));
    child.on('close', (code) => resolve({ spawned: true, code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function emitHook(homeDir, context, payload) {
  const eventName = payload.hook_event_name;
  if (typeof eventName !== 'string' || eventName.length === 0) {
    return;
  }

  const settings = readSettings(homeDir);
  const entries = Array.isArray(settings.hooks?.[eventName]) ? settings.hooks[eventName] : [];

  let matched = 0;
  for (const entry of entries) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (
        hook?.type !== 'command' ||
        typeof hook.command !== 'string' ||
        hook.command.length === 0
      ) {
        continue;
      }
      if (!isPixelAgentsHookCommand(homeDir, hook.command)) {
        continue;
      }
      matched += 1;
      const result = await runHookCommand(hook.command, payload, process.env, context.cwd);
      // Diagnostic: did the hook script run and exit cleanly? (CI macOS investigation)
      logAction(
        homeDir,
        `hookRun event=${eventName} spawned=${result.spawned} code=${result.code ?? ''} error=${result.error ?? ''}`,
      );
    }
  }
  // Diagnostic: if no registered command matched the pixel-agents hook, the
  // hook script was never spawned — log the computed path + the commands we
  // saw so a CI failure shows the mismatch instead of failing silently.
  if (matched === 0) {
    const sawCommands = entries
      .flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : []))
      .map((h) => h?.command)
      .filter(Boolean);
    logAction(
      homeDir,
      `hookNoMatch event=${eventName} home=${homeDir} commandsSeen=${JSON.stringify(sawCommands)}`,
    );
  }
}

/** Like resolveValue, for MCP arguments: object keys are templated too, and a
 *  string that is ONE whole `{{path}}` takes that value as it is (an agent id
 *  stays a number). */
function resolveMcpValue(value, context) {
  if (typeof value === 'string') {
    const whole = /^\{\{([^}]+)\}\}$/.exec(value);
    if (whole) {
      const found = lookupPath(context, whole[1]);
      if (found !== undefined && found !== null) return found;
    }
    return resolveTemplateString(value, context);
  }
  if (Array.isArray(value)) return value.map((item) => resolveMcpValue(item, context));
  if (value && typeof value === 'object') {
    const resolved = {};
    for (const [key, nested] of Object.entries(value)) {
      resolved[resolveTemplateString(key, context)] = resolveMcpValue(nested, context);
    }
    return resolved;
  }
  return value;
}

/**
 * Call one tool of the Pixel Office MCP the way Claude Code's HTTP MCP client
 * does: the endpoint and headers come from the `--mcp-config` file this
 * process was launched with (nothing else knows its token), `initialize` then
 * `tools/call`, one POST each. Resolves with the tool's parsed JSON result, or
 * `{ error }`.
 */
async function callOfficeMcp(configPath, tool, args) {
  if (!configPath) return { error: 'launched without --mcp-config' };
  const servers = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers || {};
  // The server id Pixel Agents names its MCP (OFFICE_MCP_SERVER_NAME).
  const server = servers['pixel-office'];
  if (!server || typeof server.url !== 'string') return { error: 'no pixel-office server' };
  const headers = {
    ...(server.headers || {}),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  let nextId = 1;
  const rpc = async (method, params, extraHeaders = {}) => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mock-claude', version: '0.0.0' },
    });
    const result = await rpc(
      'tools/call',
      { name: tool, arguments: args },
      { 'mcp-protocol-version': init.protocolVersion },
    );
    const text = (result.content || []).map((part) => part.text || '').join('');
    if (result.isError) return { error: text };
    return JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function playScenario(homeDir, scenario, context) {
  for (const [alias, session] of Object.entries(context.sessions)) {
    if (!session.sidecarPath || session.sidecarJson === undefined) {
      continue;
    }
    writeJsonFile(session.sidecarPath, session.sidecarJson);
    logAction(
      homeDir,
      `writeJson ${alias} ${path.basename(session.sidecarPath)} ${JSON.stringify(session.sidecarJson)}`,
    );
  }

  if (scenario.autoInit !== false) {
    appendJsonl(context.transcriptPath, {
      type: 'system',
      subtype: 'init',
      content: 'mock-claude-ready',
    });
    logAction(homeDir, `appendJsonl self init ${path.basename(context.transcriptPath)}`);
    echo(0, `session ready, transcript ${path.basename(context.transcriptPath)}`);
  }

  const actions = Array.isArray(scenario.actions) ? [...scenario.actions] : [];
  actions.sort((left, right) => (left.atMs || 0) - (right.atMs || 0));

  const startedAt = Date.now();
  for (const action of actions) {
    const atMs = typeof action.atMs === 'number' ? action.atMs : 0;
    const delayMs = Math.max(0, startedAt + atMs - Date.now());
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (action.kind === 'appendJsonl') {
      const sessionAlias = action.session || 'self';
      const target = context.sessions[sessionAlias];
      if (!target) {
        throw new Error(`Unknown mock session alias "${sessionAlias}"`);
      }

      const record = resolveValue(action.record, context);
      appendJsonl(target.transcriptPath, record);
      logAction(
        homeDir,
        `appendJsonl ${sessionAlias} ${path.basename(target.transcriptPath)} ${JSON.stringify(record)}`,
      );
      echo(
        atMs,
        `${ANSI_CYAN}append${ANSI_RESET} ${describeJsonlRecord(record)} → ${path.basename(target.transcriptPath)}`,
      );
      continue;
    }

    if (action.kind === 'emitHook') {
      const payload = resolveValue(action.payload, context);
      await emitHook(homeDir, context, payload);
      logAction(homeDir, `emitHook ${payload.hook_event_name} ${JSON.stringify(payload)}`);
      echo(atMs, `${ANSI_YELLOW}hook${ANSI_RESET} ${describeHookPayload(payload)}`);
      continue;
    }

    if (action.kind === 'writeJson') {
      const filePath = resolveTemplateString(action.filePath, context);
      const value = resolveValue(action.value, context);
      writeJsonFile(filePath, value);
      logAction(
        homeDir,
        `writeJson ${path.basename(filePath)} ${JSON.stringify({ filePath, value })}`,
      );
      echo(atMs, `${ANSI_CYAN}write${ANSI_RESET} ${path.basename(filePath)}`);
      continue;
    }

    if (action.kind === 'deletePath') {
      const filePath = resolveTemplateString(action.filePath, context);
      deletePathTarget(filePath);
      logAction(homeDir, `deletePath ${JSON.stringify({ filePath })}`);
      echo(atMs, `${ANSI_CYAN}delete${ANSI_RESET} ${path.basename(filePath)}`);
      continue;
    }

    if (action.kind === 'relocateSession') {
      // What an interactive Claude Code session does on EnterWorktree /
      // ExitWorktree: it runs in a new folder from now on, and its whole
      // transcript moves into that folder's project dir under the same name
      // (later hooks and appends follow it through {{cwd}} / {{transcriptPath}}).
      const newCwd = path.resolve(resolveTemplateString(action.cwd, context));
      const moved = ensureSessionContext(homeDir, context.sessionId, newCwd);
      if (fs.existsSync(context.transcriptPath)) {
        fs.renameSync(context.transcriptPath, moved.transcriptPath);
      }
      Object.assign(context, {
        cwd: moved.cwd,
        projectDir: moved.projectDir,
        transcriptPath: moved.transcriptPath,
      });
      Object.assign(context.sessions.self, {
        cwd: moved.cwd,
        projectDir: moved.projectDir,
        transcriptPath: moved.transcriptPath,
      });
      logAction(homeDir, `relocateSession ${JSON.stringify({ cwd: newCwd })}`);
      echo(atMs, `${ANSI_CYAN}relocate${ANSI_RESET} → ${newCwd}`);
      continue;
    }

    if (action.kind === 'callOfficeMcp') {
      if (typeof action.waitMs === 'number' && action.waitMs > 0) await sleep(action.waitMs);
      const args = resolveMcpValue(action.args || {}, context);
      const result = await callOfficeMcp(context.mcpConfigPath, action.tool, args);
      if (action.saveAs) context.mcp[action.saveAs] = result;
      logAction(homeDir, `callOfficeMcp ${action.tool} ${JSON.stringify({ args, result })}`);
      echo(
        atMs,
        `${ANSI_CYAN}mcp${ANSI_RESET} ${action.tool} → ${result && result.error ? `error: ${result.error}` : 'ok'}`,
      );
      continue;
    }

    if (action.kind === 'exit') {
      logAction(homeDir, `exit code=${action.code || 0}`);
      echo(atMs, `exit code=${action.code || 0}`);
      process.exit(typeof action.code === 'number' ? action.code : 0);
    }
  }

  const holdOpenMs =
    typeof scenario.holdOpenMs === 'number' ? scenario.holdOpenMs : DEFAULT_HOLD_OPEN_MS;
  if (holdOpenMs > 0) {
    echo(null, `scenario done, holding session open ${(holdOpenMs / 1000).toFixed(0)}s`);
    await sleep(holdOpenMs);
  }
  echo(null, 'session ended');
}

/** The code the mock's sign-in page "ends on": the one `claude auth login` accepts. */
const MOCK_SIGN_IN_CODE = 'mock-code';
const MOCK_SIGN_IN_URL = 'https://claude.example/mock-sign-in';

/**
 * `claude auth status` / `claude auth login`, as the real CLI speaks them
 * (the Intro's sign-in step). Signed in, unless the host was started with
 * PIXEL_AGENTS_MOCK_SIGNED_OUT=1: then signed out until a login with the
 * right code leaves a `signed-in` file in the mock's folder. Never a session:
 * no scenario is claimed and nothing is logged as an invocation.
 */
function mockAuth(homeDir, args) {
  const marker = path.join(getMockRoot(homeDir), 'signed-in');
  const signedIn = () => process.env.PIXEL_AGENTS_MOCK_SIGNED_OUT !== '1' || fs.existsSync(marker);
  if (args[0] === 'status') {
    process.stdout.write(
      JSON.stringify({ loggedIn: signedIn(), authMethod: signedIn() ? 'claude.ai' : 'none' }) +
        '\n',
    );
    process.exit(signedIn() ? 0 : 1);
  }
  if (args[0] === 'login') {
    logLine(homeDir, 'auth.log', JSON.stringify({ args, browser: process.env.BROWSER ?? null }));
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(`If the browser didn't open, visit: ${MOCK_SIGN_IN_URL}\n`);
    process.stdout.write('Paste code here if prompted > ');
    let typed = '';
    process.stdin.on('data', (chunk) => {
      typed += chunk;
      if (!typed.includes('\n')) return;
      if (typed.trim() === MOCK_SIGN_IN_CODE) {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, '');
        process.stdout.write('Login successful.\n');
        process.exit(0);
      }
      process.stderr.write("Login failed: That code wasn't accepted.\n");
      process.exit(1);
    });
    return;
  }
  process.exit(1);
}

async function main() {
  if (process.argv[2] === 'auth') {
    mockAuth(os.homedir(), process.argv.slice(3));
    return;
  }
  const sessionId = parseSessionId(process.argv.slice(2));
  const cwd = process.cwd();
  const homeDir = os.homedir();
  const scenario = claimScenario(homeDir) || {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    autoInit: true,
    holdOpenMs: DEFAULT_HOLD_OPEN_MS,
    sessions: [],
    actions: [],
  };

  logInvocation(homeDir, sessionId, cwd, process.argv.slice(2));
  if (IS_EXTERNAL) {
    externalTag = tinySessionTag(sessionId);
    process.stdout.write(
      `${ANSI_MAGENTA}══ EXTERNAL session ·${externalTag} — adopted by Pixel Agents, not launched ══${ANSI_RESET}\n`,
    );
  }
  echo(
    null,
    `mock claude session ${shortId(sessionId)}${scenario.name ? ` — scenario: ${scenario.name}` : ''}`,
  );

  // Shown like the TUI shows a starting prompt (the CLI's positional argument).
  const prompt = parsePrompt(process.argv.slice(2));
  if (prompt) echo(null, `> ${prompt}`);

  recordStdinIfAsked(homeDir, sessionId);
  const mcpConfigPath = argAfter(process.argv.slice(2), '--mcp-config');
  const context = buildContext(homeDir, scenario, sessionId, cwd, mcpConfigPath);
  await playScenario(homeDir, scenario, context);
}

/**
 * Opt-in (PIXEL_AGENTS_MOCK_STDIN=record): read the terminal the way Claude
 * Code's TUI does — raw mode, bracketed paste on — and record every chunk
 * typed into it (`stdin-<session id>.log` under ~/.claude-mock, one JSON
 * string per line), echoing each one to the screen so the screen changes like
 * a TUI's would. Off by default: other scenarios never read their stdin.
 */
function recordStdinIfAsked(homeDir, sessionId) {
  if (process.env.PIXEL_AGENTS_MOCK_STDIN !== 'record' || !process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdout.write('\u001b[?2004h');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    logLine(homeDir, `stdin-${sessionId}.log`, JSON.stringify(chunk));
    process.stdout.write(`typed ${JSON.stringify(chunk)}\n`);
  });
  // Reading must not keep the session open past its scenario.
  process.stdin.unref();
}

main().catch((error) => {
  const homeDir = os.homedir();
  logAction(
    homeDir,
    `error ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exitCode = 1;
});
