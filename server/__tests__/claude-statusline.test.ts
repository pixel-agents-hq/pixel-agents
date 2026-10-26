import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(__dirname, '../../dist/hooks/claude-statusline.js');

let tmpBase: string;

/** A bare HTTP server recording each request's path, auth header and body. */
function startRecordingServer(): Promise<{
  port: number;
  received: Array<{ url: string; auth: string; body: string }>;
  close: () => void;
}> {
  const received: Array<{ url: string; auth: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body });
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

function writeRegistryEntry(port: number, token: string): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${process.pid}-${port}.json`),
    JSON.stringify({
      port,
      pid: process.pid,
      token,
      startedAt: Date.now(),
      servesSpa: false,
      protocol: 1,
    }),
  );
}

function run(stdin: string, args: string[] = []): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], {
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase, COLUMNS: '77' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const wrap = (command: string): string[] => [
  '--wrap',
  Buffer.from(command, 'utf-8').toString('base64url'),
];

const INPUT = JSON.stringify({
  cwd: '/secret/project',
  session_id: 'abc',
  model: { id: 'claude-opus' },
  rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_900_000_000 } },
});

describe('claude-statusline.js integration', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-statusline-int-'));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  // Needs `npm run compile` (the bundled script); a loud skip, never a false green.
  const itBuilt = it.skipIf(!fs.existsSync(SCRIPT));

  itBuilt("reports the session's context share with the limits, nothing else", async () => {
    const server = await startRecordingServer();
    writeRegistryEntry(server.port, 'tok');

    await run(
      JSON.stringify({
        cwd: '/secret/project',
        session_id: 'abc',
        model: { id: 'claude-opus' },
        context_window: {
          used_percentage: 8,
          remaining_percentage: 92,
          context_window_size: 1_000_000,
          total_input_tokens: 80_000,
        },
      }),
    );
    server.close();

    expect(JSON.parse(server.received[0].body)).toEqual({
      session_id: 'abc',
      context_window: { used_percentage: 8, context_window_size: 1_000_000 },
    });
  });

  itBuilt('reports ONLY rate_limits, to every live server, with its token', async () => {
    const server = await startRecordingServer();
    writeRegistryEntry(server.port, 'tok');

    const { code } = await run(INPUT);
    server.close();

    expect(code).toBe(0);
    expect(server.received).toHaveLength(1);
    expect(server.received[0].url).toBe('/api/usage/claude');
    expect(server.received[0].auth).toBe('Bearer tok');
    expect(JSON.parse(server.received[0].body)).toEqual({
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_900_000_000 } },
    });
  });

  itBuilt('posts nothing when the input carries no rate limits', async () => {
    const server = await startRecordingServer();
    writeRegistryEntry(server.port, 'tok');

    await run(JSON.stringify({ cwd: '/x' }));
    server.close();

    expect(server.received).toHaveLength(0);
  });

  itBuilt("passes the user's status line through: stdin, env, output, exit code", async () => {
    const { code, stdout } = await run(
      INPUT,
      wrap(
        `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).session_id+'|'+process.env.COLUMNS);process.exit(3)})" | cat; exit 3`,
      ),
    );
    expect(stdout).toBe('abc|77\n');
    expect(code).toBe(3);
  });

  itBuilt('prints nothing and exits 0 with nothing wrapped and no server', async () => {
    const { code, stdout } = await run(INPUT);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });
});
