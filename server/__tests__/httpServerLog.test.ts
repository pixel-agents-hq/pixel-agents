/**
 * The standalone server logs every request. The privilege token rides the
 * `/ws` and `/terminal/:agentId` handshakes as `?token=`, so the request line
 * must be redacted before it is written -- otherwise every (re)connect puts the
 * secret in stdout and any log file. Pinned at the serializer seam because
 * pino's output is not something a test can capture cleanly.
 */

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { serializeRequestForLog } from '../src/httpServer.js';

function fakeRequest(url: string): FastifyRequest {
  return {
    method: 'GET',
    url,
    hostname: '127.0.0.1',
    ip: '127.0.0.1',
    socket: { remotePort: 51234 },
  } as unknown as FastifyRequest;
}

describe('request log serializer', () => {
  it('never writes the handshake token', () => {
    const secret = 'c0ffee00-1234-4abc-9def-0123456789ab';
    for (const url of [`/ws?token=${secret}`, `/terminal/1?token=${secret}`]) {
      const line = JSON.stringify(serializeRequestForLog(fakeRequest(url)));
      expect(line).not.toContain(secret);
      expect(line).toContain('token=[redacted]');
    }
  });

  it('keeps the fields Fastify logs by default', () => {
    expect(serializeRequestForLog(fakeRequest('/api/health'))).toEqual({
      method: 'GET',
      url: '/api/health',
      hostname: '127.0.0.1',
      remoteAddress: '127.0.0.1',
      remotePort: 51234,
    });
  });
});
