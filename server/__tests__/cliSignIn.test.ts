import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliSignInStatus } from '../../core/src/messages.js';
import type { CliSignInAttempt, HookProvider } from '../../core/src/provider.js';
import { CliSignIns, isCliSignInMessage } from '../src/cliSignIn.js';
import { CLI_SIGN_IN_CODE_MAX_LENGTH, CLI_SIGN_IN_TIMEOUT_MS } from '../src/constants.js';

/** A provider whose sign-in the test settles by hand. */
function fakeProvider() {
  const state = {
    signedIn: false,
    planLimits: undefined as boolean | undefined,
    begun: [] as Array<{ openBrowser: boolean; account: string }>,
    codes: [] as string[],
    cancelled: 0,
    nameUrl: (_url: string): void => undefined,
    finish: (_outcome: { ok: true } | { ok: false; reason: string }): void => undefined,
  };
  const provider = {
    id: 'fake',
    displayName: 'Fake CLI',
    cliSignIn: {
      status: async () => ({
        signedIn: state.signedIn,
        ...(state.planLimits === false ? { planLimits: false } : {}),
      }),
      begin(options: { openBrowser: boolean; account: 'subscription' | 'api' }): CliSignInAttempt {
        state.begun.push(options);
        let finish: (o: { ok: true } | { ok: false; reason: string }) => void = () => undefined;
        const done = new Promise<{ ok: true } | { ok: false; reason: string }>((r) => (finish = r));
        const url = new Promise<string>((r) => (state.nameUrl = r));
        state.finish = finish;
        return {
          url,
          done,
          submitCode: (code) => state.codes.push(code),
          cancel: () => {
            state.cancelled += 1;
            finish({ ok: false, reason: 'cancelled' });
          },
        };
      },
    },
  } as unknown as HookProvider;
  return { provider, state };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let fake: ReturnType<typeof fakeProvider>;
let signIns: CliSignIns;
let sent: CliSignInStatus[];
const client = {};
const reply = (m: CliSignInStatus): void => void sent.push(m);

beforeEach(() => {
  fake = fakeProvider();
  signIns = new CliSignIns((id) => (id === 'fake' ? fake.provider : undefined));
  sent = [];
});

afterEach(() => {
  signIns.dispose();
  vi.useRealTimers();
});

describe('CliSignIns', () => {
  it('names its three messages', () => {
    expect(isCliSignInMessage('requestCliSignInStatus')).toBe(true);
    expect(isCliSignInMessage('startCliSignIn')).toBe(true);
    expect(isCliSignInMessage('submitCliSignInCode')).toBe(true);
    expect(isCliSignInMessage('webviewReady')).toBe(false);
  });

  it('answers a status request with what the CLI says', async () => {
    signIns.handle({ type: 'requestCliSignInStatus', providerId: 'fake' }, client, reply);
    await settle();
    expect(sent).toEqual([{ type: 'cliSignInStatus', providerId: 'fake', signedIn: false }]);
  });

  it('says when the account signed in has no plan limits', async () => {
    fake.state.signedIn = true;
    fake.state.planLimits = false;
    signIns.handle({ type: 'requestCliSignInStatus', providerId: 'fake' }, client, reply);
    await settle();
    expect(sent).toEqual([
      { type: 'cliSignInStatus', providerId: 'fake', signedIn: true, planLimits: false },
    ]);
  });

  it('counts a provider with no sign-in of its own as signed in', async () => {
    const plain = new CliSignIns(() => ({ id: 'plain', displayName: 'Plain' }) as HookProvider);
    plain.handle({ type: 'requestCliSignInStatus', providerId: 'plain' }, client, reply);
    plain.handle({ type: 'startCliSignIn', providerId: 'plain', onHost: false }, client, reply);
    await settle();
    expect(sent.map((m) => m.signedIn)).toEqual([true, true]);
  });

  it('says the CLI is missing instead of asking or starting anything', async () => {
    (fake.provider as { isCliInstalled?: () => boolean }).isCliInstalled = () => false;
    signIns.handle({ type: 'requestCliSignInStatus', providerId: 'fake' }, client, reply);
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    await settle();
    const missing = {
      type: 'cliSignInStatus',
      providerId: 'fake',
      signedIn: false,
      cliMissing: true,
    };
    expect(sent).toEqual([missing, missing]);
    expect(fake.state.begun).toEqual([]);
  });

  it('ignores a provider nobody registered', async () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'nope', onHost: true }, client, reply);
    await settle();
    expect(sent).toEqual([]);
    expect(fake.state.begun).toEqual([]);
  });

  it('runs a sign-in: page, code, signed in', async () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    expect(fake.state.begun).toEqual([{ openBrowser: false, account: 'subscription' }]);
    fake.state.nameUrl('https://signin.example/page');
    await settle();
    expect(sent).toEqual([
      {
        type: 'cliSignInStatus',
        providerId: 'fake',
        signedIn: false,
        signInUrl: 'https://signin.example/page',
        openedOnHost: false,
      },
    ]);

    signIns.handle(
      { type: 'submitCliSignInCode', providerId: 'fake', code: '  code#state \n' },
      client,
      reply,
    );
    expect(fake.state.codes).toEqual(['code#state']);

    fake.state.signedIn = true;
    fake.state.finish({ ok: true });
    await settle();
    expect(sent[1]).toEqual({ type: 'cliSignInStatus', providerId: 'fake', signedIn: true });
  });

  it('passes on whether the office is on the host and which account', () => {
    signIns.handle(
      { type: 'startCliSignIn', providerId: 'fake', onHost: true, account: 'api' },
      client,
      reply,
    );
    expect(fake.state.begun).toEqual([{ openBrowser: true, account: 'api' }]);
  });

  it('needs onHost said outright', () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake' }, client, reply);
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: 'yes' }, client, reply);
    expect(fake.state.begun).toEqual([]);
  });

  it("tells why a sign-in didn't finish, and believes the CLI over the exit", async () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    fake.state.finish({ ok: false, reason: "That code wasn't accepted." });
    await settle();
    expect(sent).toEqual([
      {
        type: 'cliSignInStatus',
        providerId: 'fake',
        signedIn: false,
        error: "That code wasn't accepted.",
      },
    ]);

    // An attempt that says it worked while the CLI still reports no login is not a login.
    sent = [];
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    fake.state.finish({ ok: true });
    await settle();
    expect(sent[0].signedIn).toBe(false);
    expect(sent[0].error).toContain('Fake CLI');
  });

  it('takes a code only from the client that started the sign-in, and only one line of it', () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    const submit = (code: unknown, from: object = client): void =>
      signIns.handle({ type: 'submitCliSignInCode', providerId: 'fake', code }, from, reply);
    submit('abc', {});
    submit('two\nlines');
    submit('nul\0byte');
    submit('   ');
    submit(42);
    submit('x'.repeat(CLI_SIGN_IN_CODE_MAX_LENGTH + 1));
    expect(fake.state.codes).toEqual([]);
    submit('abc');
    expect(fake.state.codes).toEqual(['abc']);
  });

  it('shows the page only to the client that started the sign-in', async () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    fake.state.nameUrl('https://signin.example/page');
    await settle();
    const other: CliSignInStatus[] = [];
    signIns.handle({ type: 'requestCliSignInStatus', providerId: 'fake' }, {}, (m) =>
      other.push(m),
    );
    signIns.handle({ type: 'requestCliSignInStatus', providerId: 'fake' }, client, reply);
    await settle();
    expect(other[0].signInUrl).toBeUndefined();
    expect(sent[1].signInUrl).toBe('https://signin.example/page');
  });

  it('replaces a sign-in under way and lets only the new one speak', async () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    expect(fake.state.cancelled).toBe(1);
    await settle();
    expect(sent).toEqual([]); // The first one's end is not reported.
    fake.state.nameUrl('https://signin.example/second');
    await settle();
    expect(sent.map((m) => m.signInUrl)).toEqual(['https://signin.example/second']);
  });

  it('ends a sign-in left open too long and says so', async () => {
    vi.useFakeTimers();
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    await vi.advanceTimersByTimeAsync(CLI_SIGN_IN_TIMEOUT_MS + 1);
    expect(fake.state.cancelled).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].signedIn).toBe(false);
    expect(sent[0].error).toMatch(/too long/);
  });

  it('ends what is under way when the server goes down', () => {
    signIns.handle({ type: 'startCliSignIn', providerId: 'fake', onHost: false }, client, reply);
    signIns.dispose();
    expect(fake.state.cancelled).toBe(1);
  });
});
