import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      env: { ...process.env, HOME: tmpBase, ...extraEnv },
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

  // Skip if hook script not built
  function skipIfNotBuilt(): void {
    if (!fs.existsSync(HOOK_SCRIPT)) {
      console.warn(`Skipping: ${HOOK_SCRIPT} not found. Run 'npm run compile' first.`);
    }
  }

  // 1. Script reads stdin and POSTs to server
  it('reads stdin and POSTs to server', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

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
  it('exits 0 when server.json is missing', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

    // Don't write server.json
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    expect(code).toBe(0);
  });

  // 5. Script exits 0 on invalid stdin
  it('exits 0 on invalid stdin', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

    writeServerJson(9999, 'tok');
    const { code } = await runHookScript('not json at all!!!');
    expect(code).toBe(0);
  });

  // 6. Script handles server timeout
  it('exits within 5s when server does not respond', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

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
  it('fans out to every live server in the registry', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

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
  it('skips a dead-pid registry entry and still delivers to the live one', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

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
  it('skips an invalid live-pid entry and still delivers to the healthy server', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

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
  it('falls back to legacy server.json when the registry directory is empty', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

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
  it('fans out to multiple unresponsive servers in parallel, not sequentially', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

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
});
