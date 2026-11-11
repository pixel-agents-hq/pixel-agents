/**
 * Messages through the Pixel Office MCP's main seam: a composed standalone
 * server, agents launched over /ws as the office launches them — mock-claude
 * in a real PTY, reading its terminal in raw mode with bracketed paste on as
 * Claude Code's TUI does (PIXEL_AGENTS_MOCK_STDIN=record) and recording every
 * chunk typed into it — and the MCP SDK's client calling read_agent_terminal
 * and send_message with an agent's own token. Asserted from outside: what the
 * client gets back, and the bytes that reached the recipient's PTY.
 */

import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { getCharacterProfiles } from '../src/characterProfilesStore.js';
import { setOfficeMcpReadOnly } from '../src/configPersistence.js';
import { type Launched, useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

const ESC = '\x1b';

describe('Messages (composed server, mock-claude in a PTY)', () => {
  const h = useStandaloneOffice({
    name: 'pxl-office-msg',
    // The mock reads its terminal like Claude Code's TUI and records what is typed.
    env: { PIXEL_AGENTS_MOCK_STDIN: 'record' },
    grant: true,
  });
  const { sendMessage, settled } = h;

  /** The name of the character an agent wears: its Message tag, with no Nickname. */
  function characterName(id: number): string {
    return getCharacterProfiles()[h.store.get(id)!.palette!].name!;
  }

  // ── Helpers ─────────────────────────────────────────────────

  /** Launch from the office, wait for the CLI to settle, and connect as it. */
  const launch = () => h.launchAgent({ clientName: (id) => `agent-${id}` });
  /** A tool's reply: its JSON value, or its error text. */
  const call = h.callToolCaught;
  const read = h.readTerminal;
  /** The chunks typed into an agent's terminal, as the mock read them. */
  const typed = (agent: Launched) => h.typedInto(agent.sessionId);

  // ── read_agent_terminal ─────────────────────────────────────

  it('reads a screen as the terminal shows it, with a token that changes when the screen does', async () => {
    const a = await launch();
    const b = await launch();

    const first = await settled(a.client, b.id);
    // Plain text, the mock's narration as drawn: no escape sequences.
    expect(first.screen).toContain(`[mock-claude]`);
    expect(first.screen).toContain('holding session open');
    expect(first.screen).not.toContain(ESC);
    expect(first.token).toMatch(/^[0-9a-f]{16}$/);
    const again = await read(a.client, b.id);
    expect(again.screen_token).toBe(first.token);
    expect(['active', 'done', 'waiting for input', 'permission request']).toContain(again.status);

    // Something types into it (here, the user in the office): the screen and its token change.
    h.ptyManager.get(b.id)!.write('x');
    await waitFor(() => typed(b).length > 0, 'the keystroke');
    const changed = await waitFor(async () => {
      const now = await read(a.client, b.id);
      return now.screen.includes('typed "x"') ? now : null;
    }, 'the new screen');
    expect(changed.screen_token).not.toBe(first.token);

    // Without an id: the caller's own terminal.
    const own = await read(a.client);
    expect(own.agent_id).toBe(a.id);
    expect(own.screen).toContain('[mock-claude]');
  });

  // ── send_message ────────────────────────────────────────────

  it('types text as a paste tagged with the sender, then Enter on its own; submit: false leaves Enter out', async () => {
    const a = await launch();
    const b = await launch();
    const { token } = await settled(a.client, b.id);

    const results = await sendMessage(a.client, {
      to: [b.id],
      text: 'hello\nworld',
      screen_tokens: { [b.id]: token },
    });
    expect(results).toEqual([{ agent_id: b.id, delivered: true }]);
    await waitFor(() => typed(b).length >= 2, 'the text and its Enter');
    expect(typed(b)).toEqual([
      `${ESC}[200~[From ${characterName(a.id)}, agent ${a.id}] hello\rworld${ESC}[201~`,
      '\r',
    ]);

    const next = await waitFor(async () => {
      const now = await read(a.client, b.id);
      return now.screen.includes('typed "\\r"') ? now : null;
    }, 'the echo');
    const unsent = await sendMessage(a.client, {
      to: [b.id],
      text: 'draft',
      submit: false,
      screen_tokens: { [b.id]: next.screen_token },
    });
    expect(unsent[0].delivered).toBe(true);
    await waitFor(() => typed(b).length >= 3, 'the draft');
    await new Promise((r) => setTimeout(r, 400));
    expect(typed(b).slice(2)).toEqual([
      `${ESC}[200~[From ${characterName(a.id)}, agent ${a.id}] draft${ESC}[201~`,
    ]);
  });

  it('presses each named key as its bytes, bare and one write per key', async () => {
    const a = await launch();
    const b = await launch();
    const { token } = await settled(a.client, b.id);
    const keys = [
      'enter',
      'escape',
      'tab',
      'shift+tab',
      'up',
      'down',
      'right',
      'left',
      'backspace',
    ];
    keys.push(...'0123456789'.split(''));

    const results = await sendMessage(a.client, {
      to: [b.id],
      keys,
      screen_tokens: { [b.id]: token },
    });
    expect(results).toEqual([{ agent_id: b.id, delivered: true }]);
    await waitFor(() => typed(b).length >= keys.length, 'every key');
    expect(typed(b)).toEqual([
      '\r',
      ESC,
      '\t',
      `${ESC}[Z`,
      `${ESC}[A`,
      `${ESC}[B`,
      `${ESC}[C`,
      `${ESC}[D`,
      '\x7f',
      ...'0123456789'.split(''),
    ]);
  });

  it('refuses a stale or missing token with the current screen, and types nothing', async () => {
    const a = await launch();
    const b = await launch();
    const { token: stale } = await settled(a.client, b.id);
    h.ptyManager.get(b.id)!.write('z');
    await waitFor(
      async () => (await read(a.client, b.id)).screen.includes('typed "z"'),
      'the change',
    );

    const [refused] = await sendMessage(a.client, {
      to: [b.id],
      text: 'too late',
      screen_tokens: { [b.id]: stale },
    });
    expect(refused).toMatchObject({ agent_id: b.id, delivered: false });
    expect(String(refused.reason)).toMatch(/changed since you read it/);
    expect(String(refused.screen)).toContain('typed "z"');
    expect(refused.screen_token).not.toBe(stale);

    const [missing] = await sendMessage(a.client, { to: [b.id], text: 'blind', screen_tokens: {} });
    expect(missing).toMatchObject({ delivered: false, screen_token: refused.screen_token });
    expect(String(missing.reason)).toMatch(/No screen token/);

    await new Promise((r) => setTimeout(r, 400));
    expect(typed(b)).toEqual(['z']);

    // The token the refusal gave works.
    const [ok] = await sendMessage(a.client, {
      to: [b.id],
      text: 'now',
      screen_tokens: { [b.id]: refused.screen_token },
    });
    expect(ok.delivered).toBe(true);
  });

  it('messages several agents, each checked and reported on its own', async () => {
    const a = await launch();
    const b = await launch();
    const c = await launch();
    const { token: bToken } = await settled(a.client, b.id);
    await settled(a.client, c.id);

    const results = await sendMessage(a.client, {
      to: [b.id, c.id],
      text: 'team brief',
      screen_tokens: { [b.id]: bToken, [c.id]: '0000000000000000' },
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ agent_id: b.id, delivered: true });
    expect(results[1]).toMatchObject({ agent_id: c.id, delivered: false });
    await waitFor(() => typed(b).length >= 2, 'b gets it');
    await new Promise((r) => setTimeout(r, 300));
    expect(typed(c)).toEqual([]);
  });

  it('refuses a gist over 80 characters, both or neither of text/keys, and messaging yourself', async () => {
    const a = await launch();
    const b = await launch();
    const { token } = await settled(a.client, b.id);
    const base = { to: [b.id], text: 'hi', screen_tokens: { [b.id]: token } };

    const long = await call(a.client, 'send_message', { ...base, gist: 'x'.repeat(81) });
    expect(long.isError).toBe(true);
    expect(long.text).toMatch(/gist/);
    const both = await call(a.client, 'send_message', { ...base, gist: 'g', keys: ['enter'] });
    expect(both.isError).toBe(true);
    const neither = await call(a.client, 'send_message', {
      to: [b.id],
      gist: 'g',
      screen_tokens: {},
    });
    expect(neither.isError).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(typed(b)).toEqual([]);

    const exactly80 = await sendMessage(a.client, { ...base, gist: 'x'.repeat(80) });
    expect(exactly80[0].delivered).toBe(true);

    const mine = await read(a.client);
    const [self] = await sendMessage(a.client, {
      to: [a.id],
      text: 'me',
      screen_tokens: { [a.id]: mine.screen_token },
    });
    expect(self).toMatchObject({ delivered: false });
    expect(String(self.reason)).toMatch(/yourself/);
  });

  it('an adopted agent: status only on read, refused on send with a reason', async () => {
    const a = await launch();
    const adoptedId = 900;
    h.store.set(
      adoptedId,
      createAgentState({
        id: adoptedId,
        sessionId: 'adopted-session',
        projectDir: h.workspace,
        jsonlFile: path.join(h.workspace, 'adopted.jsonl'),
        isExternal: true,
      }),
    );

    const reply = await call(a.client, 'read_agent_terminal', { agent_id: adoptedId });
    expect(reply.isError).toBe(false);
    expect(reply.value).toMatchObject({ agent_id: adoptedId, status: expect.any(String) });
    expect(reply.value!.screen).toBeUndefined();
    expect(String(reply.value!.no_screen)).toMatch(/adopted/);

    const [refused] = await sendMessage(a.client, {
      to: [adoptedId],
      keys: ['enter'],
      screen_tokens: {},
    });
    expect(refused).toMatchObject({ agent_id: adoptedId, delivered: false });
    expect(String(refused.reason)).toMatch(/adopted/);

    // A headless agent of this office (no terminal of ours, not adopted).
    const headlessId = 901;
    h.store.set(
      headlessId,
      createAgentState({
        id: headlessId,
        sessionId: 'headless-session',
        projectDir: h.workspace,
        jsonlFile: path.join(h.workspace, 'headless.jsonl'),
        isExternal: false,
      }),
    );
    const headless = await call(a.client, 'read_agent_terminal', { agent_id: headlessId });
    expect(String(headless.value!.no_screen)).toMatch(/headless/);
    const [noTerminal] = await sendMessage(a.client, {
      to: [headlessId],
      text: 'hi',
      screen_tokens: {},
    });
    expect(noTerminal).toMatchObject({ agent_id: headlessId, delivered: false });
    expect(String(noTerminal.reason)).toMatch(/headless/);

    const unknown = await call(a.client, 'read_agent_terminal', { agent_id: 12345 });
    expect(unknown.isError).toBe(true);
  });

  it('read-only: reading works, messaging is refused', async () => {
    const a = await launch();
    const b = await launch();
    const { token } = await settled(a.client, b.id);
    setOfficeMcpReadOnly(true); // Settings' switch: read per call
    expect((await read(a.client, b.id)).screen_token).toBe(token);
    const refused = await call(a.client, 'send_message', {
      to: [b.id],
      text: 'hi',
      gist: 'g',
      screen_tokens: { [b.id]: token },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/read-only/);
  });
});
