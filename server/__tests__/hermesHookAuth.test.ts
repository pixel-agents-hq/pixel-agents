import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use isolated temp HOME to avoid touching real ~/.pixel-agents/
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Must import AFTER mock setup
const { PixelAgentsServer } = await import('../src/server.js');

/** Compute the Hermes X-Hermes-Signature-256 header for a raw body. */
function hermesSignature(token: string, body: string): string {
  const digest = crypto.createHmac('sha256', token).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

async function postWithSignature(
  port: number,
  token: string,
  body: string,
  providerId = 'hermes',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hermes-Signature-256': hermesSignature(token, body),
    },
    body,
  });
}

describe('hook route Hermes signature auth', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-auth-test-'));
    server = new PixelAgentsServer();
    const config = await server.start();
    port = config.port;
    token = config.token;
  });

  afterEach(() => {
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('accepts a valid X-Hermes-Signature-256 (no Bearer header)', async () => {
    const body = JSON.stringify({ session_id: 'abc', hook_event_name: 'pre_tool_call' });
    const res = await postWithSignature(port, token, body);
    expect(res.status).toBe(200);
  });

  it('still accepts the existing Bearer token contract', async () => {
    const body = JSON.stringify({ session_id: 'abc', hook_event_name: 'pre_tool_call' });
    const res = await fetch(`http://127.0.0.1:${port}/api/hooks/hermes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const body = JSON.stringify({ session_id: 'abc', hook_event_name: 'pre_tool_call' });
    const res = await postWithSignature(port, 'wrong-secret', body);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered body (signature does not match the payload)', async () => {
    const body = JSON.stringify({ session_id: 'abc', hook_event_name: 'pre_tool_call' });
    const res = await fetch(`http://127.0.0.1:${port}/api/hooks/hermes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Signature-256': hermesSignature(token, body + ' '),
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed signature headers', async () => {
    const body = JSON.stringify({ session_id: 'abc', hook_event_name: 'pre_tool_call' });
    for (const header of ['not-a-signature', 'sha256=xyz', 'sha256=' + '0'.repeat(63)]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/hooks/hermes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Signature-256': header,
        },
        body,
      });
      expect(res.status).toBe(401);
    }
  });

  it('rejects requests with no credentials at all', async () => {
    const body = JSON.stringify({ session_id: 'abc', hook_event_name: 'pre_tool_call' });
    const res = await fetch(`http://127.0.0.1:${port}/api/hooks/hermes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('fires the hook callback for a signature-authenticated event', async () => {
    const received: Array<{ providerId: string; event: Record<string, unknown> }> = [];
    server.onHookEvent((providerId, event) => received.push({ providerId, event }));
    const body = JSON.stringify({ session_id: 'sess-h1', hook_event_name: 'on_session_start' });
    const res = await postWithSignature(port, token, body);
    expect(res.status).toBe(200);
    // Give the (synchronous) callback a beat to record.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(received[0].providerId).toBe('hermes');
    expect(received[0].event.hook_event_name).toBe('on_session_start');
  });

  it('still returns 400 for invalid JSON with a valid signature', async () => {
    const badBody = 'not json {{{';
    const res = await postWithSignature(port, token, badBody);
    expect(res.status).toBe(400);
  });
});
