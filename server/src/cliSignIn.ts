/**
 * Signing a provider's CLI in from the office (the Intro's sign-in step): the
 * three client messages, answered with `cliSignInStatus`, for both surfaces.
 * The provider says how (HookProvider.cliSignIn); this owns the one sign-in
 * that may be under way per provider, who started it, and when it gives up.
 *
 * A sign-in belongs to the client that started it: only that client is told
 * its page and its end, and only that client's code is passed on. Starting
 * another replaces it. The code is handed to the provider and never kept.
 */

import type { CliSignInStatus } from '../../core/src/messages.js';
import type { CliSignInAttempt, CliSignInState, HookProvider } from '../../core/src/provider.js';
import { CLI_SIGN_IN_CODE_MAX_LENGTH, CLI_SIGN_IN_TIMEOUT_MS } from './constants.js';
import { hookProviderById } from './providers/index.js';

type Reply = (message: CliSignInStatus) => void;

interface LiveSignIn {
  attempt: CliSignInAttempt;
  /** The client that started it (the connection, or the surface's one office). */
  client: object;
  /** Set once the provider named its page. */
  url?: string;
  openedOnHost: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** A provider with a sign-in whose CLI is not on this machine: nothing can be asked or signed in yet. */
function isMissing(provider: HookProvider): boolean {
  return provider.cliSignIn !== undefined && provider.isCliInstalled?.() === false;
}

const SIGN_IN_TIMED_OUT = 'The sign-in took too long and was ended. Start it again.';

export class CliSignIns {
  private readonly live = new Map<string, LiveSignIn>();

  constructor(
    private readonly providerById: (id: unknown) => HookProvider | undefined = hookProviderById,
  ) {}

  /**
   * Answer one of `requestCliSignInStatus`, `startCliSignIn`,
   * `submitCliSignInCode`; anything else (or a provider nobody registered) is
   * ignored. `client` identifies who asks; `reply` reaches that client alone.
   * The caller has already refused read-only clients.
   */
  handle(msg: Record<string, unknown>, client: object, reply: Reply): void {
    const provider = this.providerById(msg.providerId);
    if (!provider) return;
    switch (msg.type) {
      case 'requestCliSignInStatus':
        void this.report(provider, client, reply);
        break;
      case 'startCliSignIn':
        if (typeof msg.onHost !== 'boolean') return;
        this.start(
          provider,
          client,
          reply,
          msg.onHost,
          msg.account === 'api' ? 'api' : 'subscription',
        );
        break;
      case 'submitCliSignInCode': {
        const live = this.live.get(provider.id);
        const code = typeof msg.code === 'string' ? msg.code.trim() : '';
        // One line, as the page gives it: nothing else is ever written to the CLI.
        if (!live || live.client !== client || !code || /[\r\n\0]/.test(code)) return;
        if (code.length > CLI_SIGN_IN_CODE_MAX_LENGTH) return;
        live.attempt.submitCode(code);
        break;
      }
    }
  }

  /** End every sign-in under way (the server is going down). */
  dispose(): void {
    for (const id of [...this.live.keys()]) this.end(id);
  }

  private async report(provider: HookProvider, client: object, reply: Reply): Promise<void> {
    if (isMissing(provider)) {
      reply({
        type: 'cliSignInStatus',
        providerId: provider.id,
        signedIn: false,
        cliMissing: true,
      });
      return;
    }
    const state = provider.cliSignIn ? await provider.cliSignIn.status() : { signedIn: true };
    reply(this.statusOf(provider.id, client, state));
  }

  private statusOf(
    providerId: string,
    client: object,
    state: CliSignInState,
    error?: string,
  ): CliSignInStatus {
    const { signedIn } = state;
    const live = this.live.get(providerId);
    const page = !signedIn && live?.client === client && live.url !== undefined ? live : undefined;
    return {
      type: 'cliSignInStatus',
      providerId,
      signedIn,
      ...(signedIn && state.planLimits === false ? { planLimits: false } : {}),
      ...(page ? { signInUrl: page.url, openedOnHost: page.openedOnHost } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  private start(
    provider: HookProvider,
    client: object,
    reply: Reply,
    onHost: boolean,
    account: 'subscription' | 'api',
  ): void {
    const signIn = provider.cliSignIn;
    if (!signIn) {
      reply(this.statusOf(provider.id, client, { signedIn: true }));
      return;
    }
    if (isMissing(provider)) {
      reply({
        type: 'cliSignInStatus',
        providerId: provider.id,
        signedIn: false,
        cliMissing: true,
      });
      return;
    }
    this.end(provider.id);
    const attempt = signIn.begin({ openBrowser: onHost, account });
    let timedOut = false;
    const live: LiveSignIn = {
      attempt,
      client,
      openedOnHost: onHost,
      timer: setTimeout(() => {
        if (this.live.get(provider.id) !== live) return;
        timedOut = true;
        attempt.cancel();
      }, CLI_SIGN_IN_TIMEOUT_MS),
    };
    live.timer.unref?.();
    this.live.set(provider.id, live);

    attempt.url.then(
      (url) => {
        if (this.live.get(provider.id) !== live) return;
        live.url = url;
        reply(this.statusOf(provider.id, client, { signedIn: false }));
      },
      () => undefined, // Ended before it named a page: `done` says why.
    );
    void attempt.done.then(async (outcome) => {
      // Replaced by a newer sign-in: that one speaks now.
      if (this.live.get(provider.id) !== live) return;
      this.live.delete(provider.id);
      clearTimeout(live.timer);
      // The CLI's own word, not the exit code: only a login it reports counts.
      const state = await signIn.status();
      const error = state.signedIn
        ? undefined
        : timedOut
          ? SIGN_IN_TIMED_OUT
          : outcome.ok
            ? `${provider.displayName} still reports no login. Try again.`
            : outcome.reason;
      reply(this.statusOf(provider.id, client, state, error));
    });
  }

  private end(providerId: string): void {
    const live = this.live.get(providerId);
    if (!live) return;
    this.live.delete(providerId);
    clearTimeout(live.timer);
    live.attempt.cancel();
  }
}

/** This process's sign-ins (one server, one set). */
export const cliSignIns = new CliSignIns();

/** The messages `CliSignIns.handle` answers. */
export function isCliSignInMessage(type: unknown): boolean {
  return (
    type === 'requestCliSignInStatus' || type === 'startCliSignIn' || type === 'submitCliSignInCode'
  );
}
