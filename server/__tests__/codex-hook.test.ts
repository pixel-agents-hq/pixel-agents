import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/codex-hook.js');

let tmpBase: string;

function writeServerJson(port: number, token: string): void {
  const dir = path.join(tmpBase, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.json'),
    JSON.stringify({ port, pid: process.pid, token, startedAt: Date.now() }),
  );
}

function runHookScript(stdin: string): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      env: { ...process.env, HOME: tmpBase },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    child.on('close', (code) => resolve({ code }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('codex-hook.js integration', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-hook-int-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function skipIfNotBuilt(): void {
    if (!fs.existsSync(HOOK_SCRIPT)) {
      console.warn(`Skipping: ${HOOK_SCRIPT} not found. Run 'npm run compile' first.`);
    }
  }

  it('POSTs to /api/hooks/codex', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push(`${req.url}:${body}`);
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    writeServerJson(port, 'test-token');

    const event = JSON.stringify({
      session_id: 'sess-codex',
      hook_event_name: 'Stop',
    });
    const { code } = await runHookScript(event);

    server.close();
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('/api/hooks/codex');
    expect(received[0]).toContain('sess-codex');
  });

  it('exits 0 when server.json is missing', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    expect(code).toBe(0);
  });

  it('exits 0 on invalid stdin', async () => {
    skipIfNotBuilt();
    if (!fs.existsSync(HOOK_SCRIPT)) return;

    writeServerJson(9999, 'tok');
    const { code } = await runHookScript('not json');
    expect(code).toBe(0);
  });
});
