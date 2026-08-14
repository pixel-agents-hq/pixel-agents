/**
 * Carrying out a consent answer — the half of the gate that touches disk. consentGate.ts decides WHAT an answer means;
 * this decides nothing and only performs it, per provider. Both live here rather than once per surface because a
 * duplicated gate drifts silently in either half. Surfaces differ only in HOW each effect runs (VS Code raises an
 * error modal, standalone logs), so they supply `ConsentEffects` and share the ORDER of the writes.
 */

import {
  clearHooksAnswer,
  clearHooksConsent,
  getHooksConsent,
  recordHooksDecline,
} from '../../configPersistence.js';
import { consentActionFor } from './consentGate.js';

/** The per-surface half of carrying out an answer, bound to ONE provider. Each method is the surface's EXISTING path,
 *  not one written for consent: an answer and the Settings toggle take the same route. Failure contract: every method
 *  surfaces its own failure the surface's way and RESOLVES, never rejects — answers are fire-and-forget, so a
 *  rejection reaches no one. `areHooksInstalled` is the one exception, caught per call site with its fail-closed
 *  fallback. */
export interface ConsentEffects {
  /** The full Settings-toggle path: install or uninstall, then persist the
   *  provider's preference only when the resulting on-disk state agrees, then
   *  report it. */
  setHooksEnabled(enabled: boolean): Promise<void>;
  /** Uninstall WITHOUT touching the persisted preference. */
  uninstallHooks(): Promise<void>;
  /** Read the on-disk truth. May reject (an unreadable settings file) — the
   *  one method exempted from the never-reject contract above, because only
   *  the call site knows which way a given decision fails closed. */
  areHooksInstalled(): Promise<boolean>;
  /** Sync whatever LIVE runtime state mirrors a hooks-off preference (the
   *  scanners' hooksEnabled ref). The durable writes — consent record AND
   *  preference — are the executor's own single atomic config write
   *  (recordHooksDecline), never this effect's: split across two writers,
   *  a failed half leaves a state the answer disavows. */
  syncHooksPreferenceOff(): void;
  /** Broadcast the re-derived install state to the webview. */
  reportHooksStatus(): Promise<void>;
}

/**
 * One answer at a time, per process — ONE queue across ALL providers, since they share one config.json. Revision is
 * DESIGNED for (walk Back, re-answer) and both surfaces dispatch without awaiting, so an unserialized revision could
 * observe the first answer's install mid-flight, read `installed: false`, and degrade into its no-op variant, leaving
 * hooks installed against the user's final answer. Two windows racing is a different problem, narrowed by the
 * installer's re-read-before-rename.
 */
let consentQueue: Promise<void> = Promise.resolve();

/**
 * Act on a `hooksConsentResponse` for one provider, after everything ahead of it has settled. The install state is
 * read FRESH at the head of the action, never captured when the message arrived: a revision's meaning depends on what
 * the previous answer actually left on disk.
 */
export function applyConsentChoice(
  providerId: string,
  choice: unknown,
  effects: ConsentEffects,
): Promise<void> {
  const next = consentQueue.then(() =>
    runConsentChoice(providerId, choice, effects).catch((err: unknown) => {
      // Backstop, not a handler: every effect surfaces its own failure and resolves, so nothing should reach this
      // catch. It exists because the returned promise is fire-and-forget — an escaping rejection would surface only
      // as an unhandled-rejection crash log, and one broken effect must not block every later answer in the queue.
      console.error('[Pixel Agents] Consent action failed:', err);
    }),
  );
  consentQueue = next;
  return next;
}

async function runConsentChoice(
  providerId: string,
  choice: unknown,
  effects: ConsentEffects,
): Promise<void> {
  // Fail closed: an unreadable settings file reads as "nothing of ours is
  // installed", which maps every choice to its no-file-touch variant. We never
  // uninstall on a guess.
  const installed = await effects.areHooksInstalled().catch(() => false);
  const consent = getHooksConsent(providerId);

  switch (consentActionFor(choice, { installed, consent })) {
    case 'install':
      // Clicking Install IS the consent grant, exactly like the Settings
      // toggle — so it takes that same path, which grants, installs, then
      // re-derives the on-disk state before persisting the preference.
      // Reimplementing the grant here would drop that last step. An earlier
      // decline is replaced by the toggle path's grant.
      await effects.setHooksEnabled(true);
      break;

    case 'disable':
      // A revised "never" over a landed install: the full toggle-off path (uninstall, persist off once the disk
      // agrees) plus the decline record that makes this answer revisable. The decline lands only when the removal
      // verifiably did — a decline over live entries would retire the ask while hooks keep firing.
      await effects.setHooksEnabled(false);
      if (!(await effects.areHooksInstalled().catch(() => true))) {
        recordHooksDecline(providerId);
      }
      break;

    case 'revert': {
      // A revised "not now" over a grant (or an install): undo what that answer left, clearing the consent record but
      // leaving the PREFERENCE alone (the grant never wrote it), so the world reads as if never answered.
      if (installed) {
        await effects.uninstallHooks();
        // Clear only once the removal verifiably landed; an unreadable file
        // resolves to "still there", which keeps the grant and leaves the
        // Settings toggle as the removal route.
        if (!(await effects.areHooksInstalled().catch(() => true))) {
          clearHooksConsent(providerId);
        }
        console.log('[Pixel Agents] Hook install undone — you will be asked again next time.');
      } else {
        // Nothing on disk: the grant is all that answer left (an Install recorded, then failed to write). Nothing to
        // uninstall and no settings-file read to go wrong, so clearing our own config.json is unconditional.
        clearHooksConsent(providerId);
        console.log('[Pixel Agents] Hook approval withdrawn — you will be asked again next time.');
      }
      await effects.reportHooksStatus();
      break;
    }

    case 'revertDecline': {
      // A revised "not now" over a decline: the hooks-off was the DECLINE's own write, so taking the decline back
      // takes the preference with it (key deleted, never written `true` — that would read as an answer). A decline
      // has entries on disk only when a revised "never" failed to uninstall; undo those too, and keep the decline
      // when the removal cannot be verified — fail closed, Settings stays the removal route.
      if (installed) {
        await effects.uninstallHooks();
        if (await effects.areHooksInstalled().catch(() => true)) {
          await effects.reportHooksStatus();
          break; // still installed: keep the decline, change nothing else
        }
      }
      clearHooksAnswer(providerId);
      console.log('[Pixel Agents] Hook decline withdrawn — you will be asked again next time.');
      await effects.reportHooksStatus();
      break;
    }

    case 'persistOff':
      // Record the decline and persist hooks-off WITHOUT touching the settings file: nothing of ours is installed,
      // and routing through the uninstaller would surface a file error for the act of declining. One atomic write
      // covers consent + preference; the effect only mirrors it into live runtime state.
      recordHooksDecline(providerId);
      effects.syncHooksPreferenceOff();
      console.log('[Pixel Agents] Hooks disabled. Re-enable them any time in the UI settings.');
      await effects.reportHooksStatus();
      break;

    case 'none':
      // Writes nothing; the ask fires again on the next webviewReady. Reached by a first "Not Now" (nothing to undo)
      // and by every junk value, which is why the line claims no more than that nothing was installed.
      console.log(
        '[Pixel Agents] Skipping hook install for this run — you will be asked again next time.',
      );
      break;
  }
}
