import { describe, expect, it } from 'vitest';

import {
  CONSENT_DISCLOSURE,
  CONSENT_INSTALL_HEADLINE,
} from '../src/providers/hook/claude/consentCopy.js';
import { consentActionFor, hooksConsentRequest } from '../src/providers/hook/consentGate.js';
import { claudeProvider } from '../src/providers/index.js';

/**
 * consentGate is the ONE place both surfaces decide whether to ask for hooks consent and what an answer means, per
 * provider. A surface carrying its own copy of either rule drifts silently, and a settings file in the user's home
 * directory is on the other side of the gate; these pin the policy itself, so a reimplementation has something to
 * fail against. The behaviour THROUGH each surface is pinned separately (consentFlow.test.ts, consent.spec.ts).
 */
describe('hooksConsentRequest — when to ask', () => {
  const askable = {
    installed: false,
    hooksEnabled: true,
    consentAnswered: false,
    privileged: true,
  };

  it('asks the one population with nothing of ours installed', () => {
    expect(hooksConsentRequest(askable, claudeProvider)).toEqual({
      type: 'hooksConsentRequest',
      providerId: 'claude',
      headline: CONSENT_INSTALL_HEADLINE,
      disclosure: CONSENT_DISCLOSURE,
    });
  });

  // The payload carries the provider's copy so the webview renders the exact
  // terms being approved. A client-side duplicate is the failure this guards.
  it("ships the provider's disclosure, not a summary of it", () => {
    const request = hooksConsentRequest(askable, claudeProvider);
    expect(request?.disclosure).toBe(CONSENT_DISCLOSURE);
    expect(request?.disclosure).toContain('~/.claude/settings.json');
  });

  // Each of these is a reason the ask would be wrong, not merely redundant.
  it.each([
    ['our hooks are already installed', { installed: true }],
    ['the ask was already answered', { consentAnswered: true }],
    ['the user turned hooks off', { hooksEnabled: false }],
    ['the client could not act on an answer', { privileged: false }],
  ])('does not ask when %s', (_why, override) => {
    expect(hooksConsentRequest({ ...askable, ...override }, claudeProvider)).toBeNull();
  });

  // An untokened standalone spectator's hooksConsentResponse is dropped by the
  // handler, so showing it the dialog would be asking a question whose answer
  // is discarded. The privilege check gates the ASK, not just the response.
  it('never asks an unprivileged client, even when everything else lines up', () => {
    expect(hooksConsentRequest({ ...askable, privileged: false }, claudeProvider)).toBeNull();
  });
});

describe('consentActionFor — what an answer means', () => {
  /** Nothing of ours on disk and no answer recorded: the first answer of a
   *  fresh ask, before anything has been written. */
  const untouched = { installed: false, consent: 'unanswered' } as const;
  /** What a landed Install leaves behind. */
  const landed = { installed: true, consent: 'granted' } as const;
  /** What a failed Install leaves behind: the grant is recorded BEFORE the
   *  write, so nothing is on disk. */
  const grantOnly = { installed: false, consent: 'granted' } as const;
  /** What a "Don't Ask Again" leaves behind (its hooks-off preference rides
   *  in the config, not in this state). */
  const declined = { installed: false, consent: 'declined' } as const;

  // The Intro lets the user walk back from the closing step and revise an
  // already-sent answer, so a choice is an absolute statement of desired
  // state: what a decline maps to depends on what the earlier answer left
  // behind — hooks on disk, a recorded grant, or a recorded decline.
  it('installs on an exact install, whatever the earlier answer left', () => {
    expect(consentActionFor('install', untouched)).toBe('install');
    expect(consentActionFor('install', landed)).toBe('install');
    expect(consentActionFor('install', grantOnly)).toBe('install');
    expect(consentActionFor('install', declined)).toBe('install');
  });

  it('persists hooks-off on an exact never with nothing installed', () => {
    expect(consentActionFor('never', untouched)).toBe('persistOff');
    // Repeating the decline is idempotent — same action, no special casing.
    expect(consentActionFor('never', declined)).toBe('persistOff');
    // A grant left by a FAILED install has nothing on disk: still no reason
    // to route through the uninstaller for the act of declining.
    expect(consentActionFor('never', grantOnly)).toBe('persistOff');
  });

  // A revised "never" over a landed install must remove the hooks, not merely
  // record a preference beside them — a persisted hooks-off over live entries
  // is the stranding bug: entries firing, checkbox lying, gate skipped.
  it('takes the full toggle-off path on a never over a landed install', () => {
    expect(consentActionFor('never', landed)).toBe('disable');
  });

  it('writes nothing on a notNow with nothing to undo', () => {
    expect(consentActionFor('notNow', untouched)).toBe('none');
  });

  // A revised "not now" over a landed install must leave the world exactly as
  // if never answered: uninstall AND clear the recorded grant, so the ask
  // genuinely comes back on the next open.
  it('reverts the install on a notNow over a landed install', () => {
    expect(consentActionFor('notNow', landed)).toBe('revert');
  });

  // The population issue #377 is about: a settings.json we refuse to touch.
  // Install grants BEFORE it writes, so a failed install leaves a grant with
  // nothing on disk — and the grant alone retires the ask forever. Keying the
  // revert off `installed` read this as "nothing to undo" and the user was
  // never asked again. The grant is a thing an earlier answer left behind, so
  // it is a thing "not now" has to take back.
  it('reverts a grant left by a failed install, with nothing on disk', () => {
    expect(consentActionFor('notNow', grantOnly)).toBe('revert');
  });

  // "Don't Ask Again", Back, "Not Now". The decline persisted hooks-off and the gate reads that as never-ask-again,
  // so a notNow writing nothing would retire an ask whose final answer was "ask me again". The revision must take
  // back the decline's OWN write — which is why the consent record is a tri-state: a boolean cannot express it.
  it("reverts a decline on a notNow over a Don't Ask Again", () => {
    expect(consentActionFor('notNow', declined)).toBe('revertDecline');
  });

  // A decline with entries still on disk: a revised "never" whose uninstall
  // failed. The revision arm handles the disk half itself; the mapping still
  // routes through revertDecline (the consent record is the decline).
  it('routes a notNow over a declined-but-still-installed state to revertDecline', () => {
    expect(consentActionFor('notNow', { installed: true, consent: 'declined' })).toBe(
      'revertDecline',
    );
  });

  // Every unrecognized value writes nothing — whatever the earlier answer
  // left. Junk must never be read as approval, as a durable decline (which
  // would silently retire the ask on a malformed message), or as an uninstall
  // trigger.
  it.each([
    'yes',
    'y',
    '',
    'Install',
    'INSTALL',
    'installl',
    'not-now',
    'notnow',
    'NEVER',
    'never ',
    42,
    true,
    null,
    undefined,
    {},
    ['install'],
  ])('writes nothing for %j', (junk) => {
    expect(consentActionFor(junk, untouched)).toBe('none');
    expect(consentActionFor(junk, landed)).toBe('none');
    expect(consentActionFor(junk, declined)).toBe('none');
  });
});
