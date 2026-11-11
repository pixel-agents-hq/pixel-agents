#!/usr/bin/env node
/**
 * A `claude` stand-in for the task-dispatch standalone spec. It wraps the
 * regular mock (mock-claude-runner.cjs, which plays the scenario: JSONL +
 * hooks) and adds the three things real Claude Code does that the dispatch
 * path depends on, all at the process boundary:
 *
 * 1. its TUI turns on bracketed paste (DECSET 2004) on its terminal;
 * 2. it starts the stdio MCP servers named by `--mcp-config`, with its own
 *    environment (so the Pixel Agents shim sees PIXEL_AGENTS_CAPABILITY and
 *    PIXEL_AGENTS_PORT exactly as the launcher set them in the PTY);
 * 3. it reads its terminal input raw.
 *
 * The test plays the model: it drops JSON-RPC batches into
 * ~/.claude-mock/mcp-request-<sessionId>-<n>.json; this process feeds them to
 * the shim on stdio and writes the answers to mcp-response-<sessionId>-<n>.json.
 * Every byte that arrives on the terminal input is appended, unmodified, to
 * ~/.claude-mock/pty-input-<sessionId>.log. The capability is never written
 * anywhere by this script.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ENABLE_BRACKETED_PASTE = '\u001b[?2004h';
const POLL_MS = 100;

const args = process.argv.slice(2);
const homeDir = os.homedir();
const mockRoot = path.join(homeDir, '.claude-mock');
fs.mkdirSync(mockRoot, { recursive: true });

function argAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const sessionId = argAfter('--session-id') ?? argAfter('--resume') ?? 'unknown';

// 1. The TUI's bracketed-paste request, as the first output.
process.stdout.write(ENABLE_BRACKETED_PASTE);

// 3. Raw terminal input, recorded byte for byte.
const inputLog = path.join(mockRoot, `pty-input-${sessionId}.log`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(inputLog, chunk);
  process.stdout.write(`\r\n[dispatch-probe] received ${chunk.length} bytes\r\n`);
});

// The regular mock plays the scenario (hooks + transcript); it never reads stdin.
const runner = spawn(process.execPath, [path.join(__dirname, 'mock-claude-runner.cjs'), ...args], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});
runner.on('exit', (code) => process.exit(code ?? 0));

// 2. The MCP servers from --mcp-config, started with this process's env.
const mcpConfigArg = argAfter('--mcp-config');
let shim = null;
const pending = new Map();
if (mcpConfigArg !== undefined) {
  const config = JSON.parse(mcpConfigArg);
  const server = config.mcpServers && config.mcpServers['pixel-agents'];
  if (server && server.type === 'stdio') {
    // Harness-only PATH fix (as the mock's hook runner does): `node` resolves
    // to the node running this test.
    const env = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    shim = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    readline.createInterface({ input: shim.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    });
  }
  fs.appendFileSync(
    path.join(mockRoot, 'dispatch-probes.log'),
    `${sessionId} mcp=${shim ? 'yes' : 'no'}\n`,
  );
} else {
  fs.appendFileSync(path.join(mockRoot, 'dispatch-probes.log'), `${sessionId} mcp=no\n`);
}

function send(message) {
  if (!shim) return Promise.resolve({ error: 'no shim' });
  return new Promise((resolve) => {
    if (message.id !== undefined) pending.set(message.id, resolve);
    shim.stdin.write(`${JSON.stringify(message)}\n`);
    if (message.id === undefined) resolve(null);
  });
}

let busy = false;
const requestPrefix = `mcp-request-${sessionId}-`;
setInterval(async () => {
  if (busy) return;
  const next = fs
    .readdirSync(mockRoot)
    .filter((name) => name.startsWith(requestPrefix) && name.endsWith('.json'))
    .sort()[0];
  if (!next) return;
  busy = true;
  try {
    const requestPath = path.join(mockRoot, next);
    const messages = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    fs.unlinkSync(requestPath);
    const answers = [];
    for (const message of messages) {
      const answer = await send(message);
      if (answer !== null) answers.push(answer);
    }
    const responsePath = path.join(mockRoot, next.replace('mcp-request-', 'mcp-response-'));
    fs.writeFileSync(`${responsePath}.tmp`, JSON.stringify(answers));
    fs.renameSync(`${responsePath}.tmp`, responsePath);
  } finally {
    busy = false;
  }
}, POLL_MS);
