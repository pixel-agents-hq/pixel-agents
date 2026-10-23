import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_HOOK_BODY_SIZE } from '../src/constants.js';
import { findPrUrl } from '../src/progress/phase.js';
import { shrinkHookPayload } from '../src/providers/hook/claude/hooks/claude-hook.js';

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/claude-hook.js');

// Isolated temp HOME
let tmpBase: string;

function writeServerJson(port: number, token: string): void {
  const dir = path.join(tmpBase, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.json'),
    JSON.stringify({ port, pid: process.pid, token, startedAt: Date.now() }),
  );
}

/** Write one multi-server registry entry (~/.pixel-agents/servers/<pid>-<port>.json). */
function writeRegistryEntry(pid: number, port: number, token: string): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}-${port}.json`),
    JSON.stringify({
      port,
      pid,
      token,
      startedAt: Date.now(),
      servesSpa: false,
      protocol: 1,
    }),
  );
}

/** Start a bare HTTP server that records every request body it receives. */
function startRecordingServer(): Promise<{ port: number; received: string[]; close: () => void }> {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, received, close: () => server.close() });
    });
  });
}

/** Run the hook script with given stdin, returns exit code. */
function runHookScript(
  stdin: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      // Set both HOME (POSIX) and USERPROFILE (Windows) so the child's
      // os.homedir() resolves to the isolated temp dir on every platform.
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('claude-hook.js integration', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-int-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** These tests spawn the BUNDLED hook script, so they need `npm run compile`
   *  to have run. Reported as a loud skip rather than an early `return`, which
   *  Vitest shows as PASSED with no message — a false green that hid the fact
   *  that nothing had been exercised at all. */
  const notBuilt = !fs.existsSync(HOOK_SCRIPT);
  const itBuilt = it.skipIf(notBuilt);

  // 1. Script reads stdin and POSTs to server
  itBuilt('reads stdin and POSTs to server', async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    writeServerJson(port, 'test-token');

    const event = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' });
    const { code } = await runHookScript(event);

    server.close();
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]).session_id).toBe('abc');
  });

  // 2. Script exits 0 on missing server.json
  itBuilt('exits 0 when server.json is missing', async () => {
    // Don't write server.json
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    expect(code).toBe(0);
  });

  // 5. Script exits 0 on invalid stdin
  itBuilt('exits 0 on invalid stdin', async () => {
    writeServerJson(9999, 'tok');
    const { code } = await runHookScript('not json at all!!!');
    expect(code).toBe(0);
  });

  // 6. Script handles server timeout
  itBuilt('exits within 5s when server does not respond', async () => {
    // Start a server that never responds
    const server = http.createServer(() => {
      // intentionally never respond
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    writeServerJson((server.address() as { port: number }).port, 'tok');

    const start = Date.now();
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    const elapsed = Date.now() - start;

    server.close();
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });

  // 7. Multi-server fan-out: one event reaches every live registry entry
  itBuilt('fans out to every live server in the registry', async () => {
    const a = await startRecordingServer();
    const b = await startRecordingServer();
    // Same real PID for both (this test process) is fine -- the registry
    // filename is keyed on pid+port, so two entries never collide.
    writeRegistryEntry(process.pid, a.port, 'token-a');
    writeRegistryEntry(process.pid, b.port, 'token-b');

    const event = JSON.stringify({ session_id: 'fanout', hook_event_name: 'Stop' });
    const { code } = await runHookScript(event);

    a.close();
    b.close();
    expect(code).toBe(0);
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
    expect(JSON.parse(a.received[0]).session_id).toBe('fanout');
    expect(JSON.parse(b.received[0]).session_id).toBe('fanout');
  });

  // 8. Dead-pid registry entries are skipped, not delivered to, and don't block live ones
  itBuilt('skips a dead-pid registry entry and still delivers to the live one', async () => {
    const live = await startRecordingServer();
    writeRegistryEntry(process.pid, live.port, 'token-live');
    // A stale entry for a PID that is certainly not alive. Port 9999 is
    // deliberately NOT bound by anything, so if the liveness filter failed
    // to skip it, the resulting POST would fail (ECONNREFUSED) and be
    // swallowed the same way a genuinely-filtered entry would be -- a
    // response-based assertion alone can't tell the two apart. The debug
    // log (below) is what actually proves the filter ran.
    const debugLog = path.join(tmpBase, 'hook-debug.log');
    writeRegistryEntry(999999, 9999, 'token-dead');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'skip-dead', hook_event_name: 'Stop' }),
      { PIXEL_AGENTS_DEBUG_LOG: debugLog },
    );

    live.close();
    expect(code).toBe(0);
    expect(live.received).toHaveLength(1);
    // Proves the dead entry was actually filtered by isProcessAlive, not
    // just attempted-and-failed: exactly one POST is logged (to the live
    // server), and the dead entry is logged as a registry-skip, never a POST.
    const debugText = fs.readFileSync(debugLog, 'utf-8');
    expect(debugText).toMatch(/registry-skip reason=dead-pid file=999999-9999\.json pid=999999/);
    expect(debugText).toMatch(new RegExp(`POST event=Stop sid=skip-dea port=${live.port}`));
    expect(debugText).not.toMatch(/POST event=Stop sid=skip-dea port=9999\b/);
  });

  // 9. A structurally malformed live-pid entry never poisons healthy fan-out
  itBuilt('skips an invalid live-pid entry and still delivers to the healthy server', async () => {
    const healthy = await startRecordingServer();
    writeRegistryEntry(process.pid, 70_000, 'invalid-port');
    writeRegistryEntry(process.pid, healthy.port, 'healthy-token');
    const debugLog = path.join(tmpBase, 'hook-debug.log');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'malformed-live', hook_event_name: 'Stop' }),
      { PIXEL_AGENTS_DEBUG_LOG: debugLog },
    );

    healthy.close();
    expect(code).toBe(0);
    expect(healthy.received).toHaveLength(1);
    const debugText = fs.readFileSync(debugLog, 'utf-8');
    expect(debugText).toMatch(
      new RegExp(`registry-skip reason=malformed file=${process.pid}-70000\\.json`),
    );
    expect(debugText).toMatch(new RegExp(`POST event=Stop sid=malforme port=${healthy.port}`));
    expect(debugText).not.toMatch(/POST event=Stop sid=malforme port=70000\b/);
  });

  // 10. Registry present but empty falls back to the legacy server.json
  itBuilt('falls back to legacy server.json when the registry directory is empty', async () => {
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents', 'servers'), { recursive: true });
    const legacy = await startRecordingServer();
    writeServerJson(legacy.port, 'legacy-token');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'legacy-fallback', hook_event_name: 'Stop' }),
    );

    legacy.close();
    expect(code).toBe(0);
    expect(legacy.received).toHaveLength(1);
  });

  // 11. Fan-out delivers in parallel, not sequentially: two unresponsive
  // servers must not make the script wait ~2x the per-server timeout.
  itBuilt('fans out to multiple unresponsive servers in parallel, not sequentially', async () => {
    const hang = (): Promise<{ port: number; close: () => void }> => {
      const server = http.createServer(() => {
        // intentionally never respond
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve({
            port: (server.address() as { port: number }).port,
            close: () => server.close(),
          });
        });
      });
    };
    const a = await hang();
    const b = await hang();
    writeRegistryEntry(process.pid, a.port, 'token-a');
    writeRegistryEntry(process.pid, b.port, 'token-b');

    const start = Date.now();
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'parallel-timeout', hook_event_name: 'Stop' }),
    );
    const elapsed = Date.now() - start;

    a.close();
    b.close();
    expect(code).toBe(0);
    // Each POST times out at 2s; sequential delivery would take ~4s+. A
    // generous 3.5s ceiling proves the two requests ran concurrently.
    expect(elapsed).toBeLessThan(3500);
  });

  // 12. An event bigger than the server's body limit still arrives (shrunk),
  // instead of being rejected with 413 and silently lost.
  itBuilt('delivers an oversized PostToolUse under the server body limit', async () => {
    const server = await startRecordingServer();
    writeServerJson(server.port, 'tok');
    const url = 'https://github.com/octo/repo/pull/7';
    const event = JSON.stringify({
      session_id: 'oversized',
      transcript_path: '/home/me/.claude/projects/p/oversized.jsonl',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "Fix" --body "b"' },
      tool_response: { stdout: `${url}\n${'log line\n'.repeat(100_000)}`, stderr: '' },
    });
    expect(Buffer.byteLength(event)).toBeGreaterThan(MAX_HOOK_BODY_SIZE);
    const debugLog = path.join(tmpBase, 'hook-debug.log');

    const { code } = await runHookScript(event, { PIXEL_AGENTS_DEBUG_LOG: debugLog });

    server.close();
    expect(code).toBe(0);
    expect(server.received).toHaveLength(1);
    expect(Buffer.byteLength(server.received[0])).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    // sid is the session id's first 8 chars.
    expect(fs.readFileSync(debugLog, 'utf-8')).toMatch(
      /shrunk event=PostToolUse sid=oversize bytes=\d+->\d+/,
    );
    const delivered = JSON.parse(server.received[0]) as Record<string, unknown>;
    expect(delivered.session_id).toBe('oversized');
    expect(delivered.transcript_path).toBe('/home/me/.claude/projects/p/oversized.jsonl');
    expect(findPrUrl(delivered.tool_response as string)).toBe(url);
  });
});

// ── shrinkHookPayload (pure) ─────────────────────────────────────────────────

/** Bytes the hook would POST for this payload. */
function bodyBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/** Fields every Claude Code hook payload carries; the shrink must never touch them. */
const COMMON = {
  session_id: 'sess-1234',
  transcript_path: '/home/me/.claude/projects/p/sess-1234.jsonl',
  agent_transcript_path: '/home/me/.claude/projects/p/sess-1234/subagents/agent-1.jsonl',
  cwd: '/home/me/proj',
  permission_mode: 'default',
};

/** A truncated string keeps at most its cap plus a short marker. */
const MARKER_SLACK = 64;

describe('shrinkHookPayload', () => {
  it('leaves payloads that are already small unchanged, byte for byte', () => {
    let deep: unknown = { leaf: 'x' };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const raws = [
      JSON.stringify({ ...COMMON, hook_event_name: 'Stop', stop_hook_active: false }),
      JSON.stringify({
        ...COMMON,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        tool_input: { command: 'npm test', description: 'Run tests', timeout: 120000 },
      }),
      JSON.stringify({
        ...COMMON,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_2',
        tool_input: { command: 'ls', run_in_background: false },
        tool_response: { stdout: 'a'.repeat(2000), stderr: '', interrupted: false, isImage: false },
      }),
      JSON.stringify({
        ...COMMON,
        hook_event_name: 'PreToolUse',
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [
            { content: 'one', status: 'pending', activeForm: 'Doing one' },
            { content: 'two', status: 'completed', activeForm: 'Doing two' },
          ],
          exactlyAtCap: 'y'.repeat(2048),
          deep,
          nothing: null,
          flags: [true, 1, 'z'],
        },
      }),
      JSON.stringify({
        ...COMMON,
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/home/me/proj/a.ts' },
        tool_response: 'short text',
      }),
    ];
    for (const raw of raws) {
      expect(JSON.stringify(shrinkHookPayload(JSON.parse(raw)))).toBe(raw);
    }
  });

  it('shrinks a big Read response below the limit, keeping its start and every other field', () => {
    const raw = {
      ...COMMON,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_use_id: 'toolu_read',
      tool_input: { file_path: '/home/me/proj/huge.log' },
      tool_response: {
        type: 'text',
        file: {
          filePath: '/home/me/proj/huge.log',
          content: 'line of the file\n'.repeat(50_000),
          numLines: 50_000,
          startLine: 1,
          totalLines: 50_000,
        },
      },
    };
    expect(bodyBytes(raw)).toBeGreaterThan(MAX_HOOK_BODY_SIZE);

    const out = shrinkHookPayload(raw);

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect(typeof out.tool_response).toBe('string');
    const response = out.tool_response as string;
    expect(response.length).toBeLessThanOrEqual(4096 + MARKER_SLACK);
    expect(response.startsWith('{"type":"text","file":{"filePath":"/home/me/proj/huge.log"')).toBe(
      true,
    );
    expect(out.tool_input).toEqual({ file_path: '/home/me/proj/huge.log' });
    for (const [key, value] of Object.entries(COMMON)) expect(out[key]).toBe(value);
    expect(out.hook_event_name).toBe('PostToolUse');
    expect(out.tool_name).toBe('Read');
    expect(out.tool_use_id).toBe('toolu_read');
  });

  it('keeps the PR url gh pr create prints in its first lines', () => {
    const url = 'https://github.com/octo/repo/pull/42';
    const raw = {
      ...COMMON,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "Fix" --body "b"' },
      tool_response: {
        stdout: `${url}\n${'warning: something long\n'.repeat(10_000)}`,
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    };

    const out = shrinkHookPayload(raw);

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect(findPrUrl(out.tool_response as string)).toBe(url);
  });

  it('keeps the PR url a chained command prints at the end of a long output', () => {
    const url = 'https://github.com/octo/repo/pull/43';
    const raw = {
      ...COMMON,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm run check && gh pr create --title "Fix" --body "b"' },
      tool_response: `${'check output line\n'.repeat(10_000)}${url}\n`,
    };

    const out = shrinkHookPayload(raw);

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect((out.tool_response as string).length).toBeLessThanOrEqual(4096 + MARKER_SLACK);
    expect(findPrUrl(out.tool_response as string)).toBe(url);
  });

  it('truncates a big Write content but keeps file_path', () => {
    const content = 'const x = 1;\n'.repeat(50_000);
    const raw = {
      ...COMMON,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/home/me/proj/big.ts', content },
    };

    const out = shrinkHookPayload(raw);
    const input = out.tool_input as Record<string, unknown>;

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect(input.file_path).toBe('/home/me/proj/big.ts');
    const shrunk = input.content as string;
    expect(shrunk.length).toBeLessThanOrEqual(2048 + MARKER_SLACK);
    expect(shrunk.startsWith(content.slice(0, 2000))).toBe(true);
    for (const [key, value] of Object.entries(COMMON)) expect(out[key]).toBe(value);
  });

  it("truncates both of a big Edit's strings, keeping the short fields intact", () => {
    const raw = {
      ...COMMON,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: '/home/me/proj/a.ts',
        old_string: 'o'.repeat(40_000),
        new_string: 'n'.repeat(40_000),
        replace_all: false,
      },
    };

    const out = shrinkHookPayload(raw);
    const input = out.tool_input as Record<string, unknown>;

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect(input.file_path).toBe('/home/me/proj/a.ts');
    expect(input.replace_all).toBe(false);
    expect((input.old_string as string).length).toBeLessThanOrEqual(2048 + MARKER_SLACK);
    expect((input.new_string as string).length).toBeLessThanOrEqual(2048 + MARKER_SLACK);
  });

  it('bounds long arrays and deep nesting in tool_input', () => {
    let deep: unknown = { leaf: 'd'.repeat(50_000) };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const raw = {
      ...COMMON,
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__some__tool',
      tool_input: {
        items: Array.from({ length: 5000 }, (_, i) => `item-${i}`),
        deep,
      },
    };

    const out = shrinkHookPayload(raw);
    const input = out.tool_input as Record<string, unknown>;

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect((input.items as string[]).length).toBeLessThan(5000);
    expect((input.items as string[])[0]).toBe('item-0');
    expect(JSON.stringify(input.deep).length).toBeLessThan(4096);
  });

  it('never splits a surrogate pair when it truncates', () => {
    const raw = {
      ...COMMON,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      // The one-char prefix/suffix put the pairs at odd offsets, so a naive cut
      // at an even length lands between the halves of a pair.
      tool_input: {
        file_path: '/home/me/proj/emoji.md',
        content: `x${'\u{1F600}'.repeat(30_000)}`,
      },
      tool_response: `x${'\u{1F600}'.repeat(30_000)}y`,
    };

    const out = shrinkHookPayload(raw);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect(loneSurrogate.test((out.tool_input as Record<string, string>).content)).toBe(false);
    expect(loneSurrogate.test(out.tool_response as string)).toBe(false);
  });

  it('drops tool_input and tool_response when shrinking them still leaves it too big', () => {
    const raw = {
      ...COMMON,
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__bulk__upload',
      tool_use_id: 'toolu_bulk',
      tool_input: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`field${i}`, 'v'.repeat(5000)]),
      ),
      tool_response: 'r'.repeat(100_000),
    };

    const out = shrinkHookPayload(raw);

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect(out).not.toHaveProperty('tool_input');
    expect(out).not.toHaveProperty('tool_response');
    for (const [key, value] of Object.entries(COMMON)) expect(out[key]).toBe(value);
    expect(out.hook_event_name).toBe('PreToolUse');
    expect(out.tool_name).toBe('mcp__bulk__upload');
    expect(out.tool_use_id).toBe('toolu_bulk');
  });

  it('as a last resort clips another oversized field rather than lose the event', () => {
    // A failed command's full output arrives in a field the server never reads.
    const raw = {
      ...COMMON,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'toolu_fail',
      tool_input: { command: 'npm test' },
      error: `Exit code 1\n${'FAIL something\n'.repeat(20_000)}`,
    };

    const out = shrinkHookPayload(raw);

    expect(bodyBytes(out)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    for (const [key, value] of Object.entries(COMMON)) expect(out[key]).toBe(value);
    expect(out.hook_event_name).toBe('PostToolUseFailure');
    expect(out.tool_use_id).toBe('toolu_fail');
    expect((out.error as string).startsWith('Exit code 1\nFAIL something')).toBe(true);
  });

  it('does not modify the payload it is given', () => {
    const raw = {
      ...COMMON,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/home/me/proj/big.ts', content: 'c'.repeat(100_000) },
      tool_response: 'r'.repeat(100_000),
    };
    const before = JSON.stringify(raw);

    shrinkHookPayload(raw);

    expect(JSON.stringify(raw)).toBe(before);
  });
});
