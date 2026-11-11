/**
 * The Message show through the Pixel Office MCP's main seam: send_message
 * from one agent to others (mock-claude in real PTYs, as in
 * officeMcpMessaging.test.ts) and what the open offices are told —
 * `agentMessageShow` with the sender, the recipients the message reached and
 * the gist, after delivery; never for a message that reached no one, and
 * never replayed to an office that opens later.
 */

import { describe, expect, it } from 'vitest';

import { useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

describe('Message show (composed server, mock-claude in a PTY)', () => {
  const h = useStandaloneOffice({
    name: 'pxl-office-show',
    // The mock reads its terminal like Claude Code's TUI and records what is typed.
    env: { PIXEL_AGENTS_MOCK_STDIN: 'record' },
    grant: true,
  });
  const { sendMessage, settled } = h;

  /** Launch from the office, wait for the CLI to settle, and connect as it. */
  const launch = () => h.launchAgent({ clientName: (id) => `agent-${id}` });

  /** Every agentMessageShow the office socket was sent. */
  function shows(): Array<Record<string, unknown>> {
    return h.received.filter((m) => m.type === 'agentMessageShow');
  }

  it('a delivered message is shown to the open offices: sender, recipients in order, gist', async () => {
    const a = await launch();
    const b = await launch();
    const c = await launch();
    const tb = await settled(a.client, b.id);
    const tc = await settled(a.client, c.id);

    const results = await sendMessage(a.client, {
      to: [c.id, b.id],
      text: 'please review',
      gist: 'Review the parser, please',
      screen_tokens: { [b.id]: tb.token, [c.id]: tc.token },
    });
    expect(results.every((r) => r.delivered)).toBe(true);
    await waitFor(() => shows().length > 0, 'the show');
    expect(shows()).toEqual([
      {
        type: 'agentMessageShow',
        fromId: a.id,
        toIds: [c.id, b.id],
        gist: 'Review the parser, please',
      },
    ]);
  });

  it('only the recipients the message reached are visited; a message that reached no one shows nothing', async () => {
    const a = await launch();
    const b = await launch();
    const c = await launch();
    const tb = await settled(a.client, b.id);

    // c's token is missing: refused, so only b is visited.
    const results = await sendMessage(a.client, {
      to: [b.id, c.id],
      keys: ['enter'],
      gist: 'Approving',
      screen_tokens: { [b.id]: tb.token },
    });
    expect(results.map((r) => r.delivered)).toEqual([true, false]);
    await waitFor(() => shows().length > 0, 'the show');
    expect(shows()).toEqual([
      { type: 'agentMessageShow', fromId: a.id, toIds: [b.id], gist: 'Approving' },
    ]);

    const none = await sendMessage(a.client, {
      to: [c.id],
      text: 'hi',
      gist: 'Nobody hears this',
      screen_tokens: { [c.id]: 'stale' },
    });
    expect(none[0].delivered).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(shows()).toHaveLength(1);
  });

  it('is not replayed: an office that opens after the message sees no show', async () => {
    const a = await launch();
    const b = await launch();
    const tb = await settled(a.client, b.id);
    await sendMessage(a.client, {
      to: [b.id],
      text: 'hello',
      gist: 'Hello there',
      screen_tokens: { [b.id]: tb.token },
    });
    await waitFor(() => shows().length > 0, 'the show');

    const late = await h.connectOffice();
    await new Promise((r) => setTimeout(r, 300));
    late.socket.close();
    expect(late.received.some((m) => m.type === 'agentMessageShow')).toBe(false);
  });
});
