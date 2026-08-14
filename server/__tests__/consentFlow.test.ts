import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  setHooksEnabled,
} from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import {
  CONSENT_DISCLOSURE,
  CONSENT_INSTALL_HEADLINE,
} from '../src/providers/hook/claude/consentCopy.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';

/** Let a dispatch's async chain (side effect → areHooksInstalled → persist →
 *  send) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * The in-app first-run consent flow through the standalone dispatch: the server asks over the wire during the
 * webviewReady handshake and acts on the answer via the shared modules (consentGate decides, consentExecutor
 * performs). Chief among the pinned semantics: nothing but an exact, explicit approval ever installs, and junk is
 * never read as one. Everything is per-provider — ask and answer name 'claude', records live in config.json's maps.
 */
describe('clientMessageHandler: hooks consent flow', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  /** Put our command on every installed event, as a real install would. */
  function seedInstalledHooks(): void {
    const command = `node "${path.join(tempHome, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
    const entry = { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] };
    fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [entry]])),
      }),
    );
  }

  function settingsJsonExists(): boolean {
    return fs.existsSync(path.join(tempHome, '.claude', 'settings.json'));
  }

  /** The strongest possible "writes nothing": the config file was never even
   *  created. */
  function configJsonExists(): boolean {
    return fs.existsSync(path.join(tempHome, '.pixel-agents', 'config.json'));
  }

  function answer(choice: unknown, providerId: unknown = 'claude'): void {
    handleClientMessage(
      { type: 'hooksConsentResponse', providerId, choice },
      (m) => sent.push(m),
      ctx,
    );
  }

  async function connect(): Promise<void> {
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
    await settle(); // the request rides the async areHooksInstalled follow-up
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-consent-flow-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = { store, cache: null, privileged: true };
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── hooksConsentRequest: who is asked, and on what terms ─────

  describe('hooksConsentRequest on webviewReady', () => {
    // The request carries the provider's exact disclosure so the dialog cannot
    // render weaker terms than the ones consentCopy.test.ts pins.
    it('asks a privileged connection, carrying the provider disclosure verbatim', async () => {
      await connect();

      const request = sent.find((m) => m.type === 'hooksConsentRequest');
      expect(request).toEqual({
        type: 'hooksConsentRequest',
        providerId: 'claude',
        headline: CONSENT_INSTALL_HEADLINE,
        disclosure: CONSENT_DISCLOSURE,
      });
      // After the truthful install state, never before: the webview treats
      // hooksStatus installed=true as "the ask is moot", so a request sent
      // ahead of the status it depends on could be closed by its own handshake.
      const types = sent.map((m) => m.type);
      expect(types.indexOf('hooksStatus')).toBeLessThan(types.indexOf('hooksConsentRequest'));
    });

    // A spectator's answer would be ignored (below), so showing it the dialog
    // would be a lie.
    it('never asks an unprivileged connection', async () => {
      ctx.privileged = false;
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    it('never asks once consent is recorded', async () => {
      grantHooksConsent('claude');
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    // The silent-grant population (a pre-consent version's install, migrated at
    // startup): exactly one population is prompted — the one with NOTHING of
    // ours installed.
    it('never asks while our hooks are already installed', async () => {
      seedInstalledHooks();
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    it('never asks while the hooks preference is off', async () => {
      // The preference alone (a Settings toggle-off records no consent), so
      // this isolates the hooksEnabled gate from the consentAnswered gate.
      setHooksEnabled('claude', false);
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    // Not-now writes nothing, so the gate must still be open on the next
    // connect — the re-ask is what makes dismissal safe to fail closed.
    it('asks again on the next connect after a notNow', async () => {
      await connect();
      answer('notNow');
      await settle();
      sent = [];

      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });
  });

  // ── hooksConsentResponse: what each answer writes ────────────

  describe('hooksConsentResponse', () => {
    it('install runs the install side effect and persists the preference on success', async () => {
      let sideEffect: { providerId: string; enabled: boolean } | undefined;
      ctx.onSetHooksEnabled = (providerId, enabled) => {
        sideEffect = { providerId, enabled };
        seedInstalledHooks(); // the install landed
      };

      answer('install');
      await settle();

      expect(sideEffect).toEqual({ providerId: 'claude', enabled: true });
      expect(getHooksEnabled('claude')).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // Same stranding rule as the Settings toggle: intent is never persisted
    // over an outcome that disagrees with it.
    it('install does not persist hooks-on when the install failed', async () => {
      answer('never'); // persists hooks-off first
      await settle();
      ctx.onSetHooksEnabled = () => {
        /* the install failed: settings.json stays absent */
      };

      answer('install');
      await settle();

      expect(getHooksEnabled('claude')).toBe(false);
      expect(sent.filter((m) => m.type === 'hooksStatus').at(-1)).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
      });
    });

    it('never records the decline and hooks-off without touching settings.json', async () => {
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      answer('never');
      await settle();

      expect(getHooksEnabled('claude')).toBe(false);
      // The decline is durable AND revisable: it is what a later notNow undoes.
      expect(getHooksConsent('claude')).toBe('declined');
      expect(sideEffectRan).toBe(false);
      expect(settingsJsonExists()).toBe(false);
    });

    it('notNow writes nothing at all', async () => {
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      answer('notNow');
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(settingsJsonExists()).toBe(false);
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(configJsonExists()).toBe(false);
    });

    // The retired TTY prompt's core pin, translated: junk must never be read
    // as approval — OR as a durable decline. Every unrecognized choice takes
    // the notNow path (write nothing, ask again), including near-misses of the
    // real values.
    it.each(['yes', 'y', '', 'Install', 'INSTALL', 'installl', 'not-now', 'NEVER', 42, true, null])(
      'unrecognized choice %j writes nothing',
      async (junk) => {
        let sideEffectRan = false;
        ctx.onSetHooksEnabled = () => {
          sideEffectRan = true;
        };

        answer(junk);
        await settle();

        expect(sideEffectRan).toBe(false);
        expect(settingsJsonExists()).toBe(false);
        expect(getHooksConsent('claude')).toBe('unanswered');
        expect(configJsonExists()).toBe(false);
      },
    );

    // The provider id is echoed from the request, so an id naming no
    // registered provider is a crafted message — dropped exactly like junk.
    // A MISSING id too: the pre-providerId wire shape must not act on anything.
    it.each([['copilot'], [''], [42], [null], [{}], ['missing']])(
      'unknown providerId %j writes nothing, even with a real choice',
      async (junkId) => {
        let sideEffectRan = false;
        ctx.onSetHooksEnabled = () => {
          sideEffectRan = true;
        };

        const msg: Record<string, unknown> = { type: 'hooksConsentResponse', choice: 'install' };
        if (junkId !== 'missing') msg.providerId = junkId;
        handleClientMessage(msg, (m) => sent.push(m), ctx);
        await settle();

        expect(sideEffectRan).toBe(false);
        expect(getHooksConsent('claude')).toBe('unanswered');
        expect(configJsonExists()).toBe(false);
      },
    );

    // The answer is only ever solicited from privileged connections; one
    // arriving without the token is a crafted message, not a user decision.
    it('ignores every choice from an unprivileged client', async () => {
      ctx.privileged = false;
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      for (const choice of ['install', 'never', 'notNow']) {
        answer(choice);
      }
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(settingsJsonExists()).toBe(false);
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(configJsonExists()).toBe(false);
    });
  });

  // ── hooksConsentResponse revisions: Back from the Intro's closing step ───
  // The Intro lets the user return to the consent step after an answer landed and pick a different one. A choice is
  // an absolute statement of desired state, so a revision must UNDO what the earlier answer left: hooks on disk, a
  // recorded grant, or a recorded decline with its persisted hooks-off.
  describe('hooksConsentResponse revision over an earlier answer', () => {
    /** What a successful uninstall leaves behind. */
    function removeOurHooks(): void {
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'settings.json'),
        JSON.stringify({ hooks: {} }),
      );
    }

    it('a revised never takes the full toggle-off path: uninstall, then persist off', async () => {
      seedInstalledHooks();
      grantHooksConsent('claude'); // the earlier Install recorded the grant
      let sideEffect: { providerId: string; enabled: boolean } | undefined;
      ctx.onSetHooksEnabled = (providerId, enabled) => {
        sideEffect = { providerId, enabled };
        if (!enabled) removeOurHooks();
      };

      answer('never');
      await settle();

      expect(sideEffect).toEqual({ providerId: 'claude', enabled: false });
      expect(getHooksEnabled('claude')).toBe(false);
      // The record flips to the decline — the truthful current answer, and
      // the provenance a later notNow revision reads.
      expect(getHooksConsent('claude')).toBe('declined');
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
      });
    });

    it('a revised notNow reverts everything: uninstall, clear the record, preference untouched', async () => {
      seedInstalledHooks();
      grantHooksConsent('claude');
      ctx.onSetHooksEnabled = (_providerId, enabled) => {
        if (!enabled) removeOurHooks();
      };

      answer('notNow');
      await settle();

      expect(getHooksConsent('claude')).toBe('unanswered');
      // "Not now" must not persist hooks-off — that would retire the ask.
      expect(getHooksEnabled('claude')).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
      });

      // The load-bearing half: the world is as if never answered, so the next
      // connect asks again.
      sent = [];
      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });

    // Fail closed on a failed undo: while entries are still on disk and still
    // firing, the grant must stay recorded — a cleared record over live hooks
    // would make the startup migration re-grant silently, but the truthful
    // hooksStatus is what the UI renders either way.
    it('a failed revert keeps the grant and reports hooks still installed', async () => {
      seedInstalledHooks();
      grantHooksConsent('claude');
      ctx.onSetHooksEnabled = () => {
        /* the uninstall failed: our entries stay */
      };

      answer('notNow');
      await settle();

      expect(getHooksConsent('claude')).toBe('granted');
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // The population issue #377 is about: a settings.json the installer refuses to touch. `install` records the grant
    // BEFORE it writes, so a failed install leaves a grant with nothing on disk — and the grant alone retires the ask.
    // Reading the revert off `installed` saw "nothing to undo" and stranded the user with an ask that never came back.
    it('a revised notNow clears a grant left by a FAILED install', async () => {
      grantHooksConsent('claude'); // the Install click landed the grant...
      // ...and nothing is on disk: the install threw and wrote nothing.
      let uninstallAttempted = false;
      ctx.onSetHooksEnabled = () => {
        uninstallAttempted = true;
      };

      answer('notNow');
      await settle();

      expect(getHooksConsent('claude')).toBe('unanswered');
      // Nothing of ours is installed, so there is nothing to remove — and
      // routing through the uninstaller would surface a file error for the act
      // of declining.
      expect(uninstallAttempted).toBe(false);
      expect(getHooksEnabled('claude')).toBe(true);

      // The load-bearing half: the ask genuinely comes back.
      sent = [];
      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });

    // The other stranding cell: "Don't Ask Again", Back, "Not Now". The decline persisted hooks-off and the gate
    // reads that as never-ask-again, so a notNow that "wrote nothing" would retire an ask whose FINAL answer was "ask
    // me again". The revision takes back both the decline and its own preference write.
    it("a revised notNow takes back a Don't Ask Again entirely — the ask returns", async () => {
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      answer('never');
      await settle();
      expect(getHooksConsent('claude')).toBe('declined');
      expect(getHooksEnabled('claude')).toBe(false);

      answer('notNow');
      await settle();

      // The world is as if never answered: no record, default preference,
      // nothing installed, and no settings-file access for either answer.
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      expect(sideEffectRan).toBe(false);
      expect(settingsJsonExists()).toBe(false);

      // The load-bearing half: the ask genuinely comes back.
      sent = [];
      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });

    // The three-answer stranding cell: never → install (which FAILS) → notNow. The install's grant replaces the
    // decline and takes its hooks-off remnant in the SAME write, so the failed install leaves granted + default
    // enabled and the final notNow reverts to a world where the ask returns. Leaving the remnant would end at
    // unanswered + hooks-off: an ask suppressed forever although the final answer was "ask me again".
    it('never, then a FAILED install, then notNow — the ask still returns', async () => {
      ctx.onSetHooksEnabled = (_providerId, enabled) => {
        // The real side effect (cli.ts) grants BEFORE it writes; here the
        // write itself fails, so settings.json stays absent.
        if (enabled) grantHooksConsent('claude');
      };

      answer('never');
      await settle();
      expect(getHooksConsent('claude')).toBe('declined');
      expect(getHooksEnabled('claude')).toBe(false);

      answer('install');
      await settle();
      expect(getHooksConsent('claude')).toBe('granted');
      // The grant took the decline's preference remnant with it.
      expect(getHooksEnabled('claude')).toBe(true);

      answer('notNow');
      await settle();
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);

      // The load-bearing half: the ask genuinely comes back.
      sent = [];
      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });

    // The Intro is DESIGNED to produce two answers in a row (walk Back, revise). Both dispatch without awaiting and
    // each re-reads the disk to decide what it means, so an unserialized revision could observe the first answer's
    // install mid-flight, read "nothing installed", and degrade into its no-op variant — leaving hooks installed
    // against the user's final answer.
    it('serializes a revision sent while the first answer is still installing', async () => {
      let resolveInstall: (() => void) | undefined;
      ctx.onSetHooksEnabled = (_providerId, enabled) => {
        if (enabled) {
          // The real side effect (cli.ts) grants BEFORE it writes, then
          // installs. Here the write is a slow one that only lands when we
          // let it, so the revision can arrive mid-flight.
          grantHooksConsent('claude');
          return new Promise<void>((resolve) => {
            resolveInstall = () => {
              seedInstalledHooks();
              resolve();
            };
          });
        }
        removeOurHooks();
        return undefined;
      };

      answer('install');
      // The revision arrives before the install has written anything.
      answer('never');
      await settle();
      expect(resolveInstall).toBeDefined();
      resolveInstall!();
      await settle();

      // The revision ran AFTER the install landed, so it saw the hooks and
      // took the full toggle-off path rather than merely persisting a
      // preference beside live entries.
      expect(getHooksConsent('claude')).toBe('declined');
      expect(getHooksEnabled('claude')).toBe(false);
      expect(sent.filter((m) => m.type === 'hooksStatus').at(-1)).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
      });
    });
  });
});
