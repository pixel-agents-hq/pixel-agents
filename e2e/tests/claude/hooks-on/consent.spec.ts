import fs from 'node:fs';
import path from 'node:path';

import type { Frame, Locator } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { ourHookEvents } from '../../../helpers/hooks';
import {
  advanceIntroToChoices,
  backInIntro,
  chooseInIntro,
  finishIntro,
  introChoice,
  readIntro,
} from '../../../helpers/intro';
import { getSettingChecked, setSettings } from '../../../helpers/webview';

/**
 * The Intro — the first-run tour — and, inside it, the consent gate for modifying ~/.claude/settings.json.
 * Every other spec seeds a granted Claude consent so hooks flow silently; these opt OUT via `seedConfig`, which is
 * what a real first run looks like. The tour is diegetic: a greeter stands near the office's bottom-left corner and
 * the IntroDialog is its dialog box, driven by the server's `hooksConsentRequest`, paging welcome → (get Claude Code) →
 * choices → all set. The choices step's Live updates box starts off; Continue sends its answer (ticked = install,
 * left off = never) and moves to the closing step, from which Back allows a genuine change of mind. Both surfaces render this component off the same message (standalone: standalone/hooks.spec.ts).
 * The gate answers a 1-star review — a settings.json replaced with no prompt, backup or disclosure — so these assert
 * the ON-DISK consequence of each choice, not just that a prompt appeared.
 */

const NO_CONSENT_CONFIG = {
  vscode: { alwaysShowLabels: true, showHostDirectories: true },
  standalone: { alwaysShowLabels: true, showHostDirectories: true },
  // hooksConsent deliberately absent -> parses to unanswered -> dialog shows.
  // The Pixel Office MCP ask is answered: these specs are about the hooks step.
  officeMcpConsent: 'declined',
};

/** The in-app Intro. IntroDialog is the only role="dialog" element
 *  in the webview (the Settings/changelog modals don't carry the role). */
function consentDialog(frame: Frame): Locator {
  return frame.getByRole('dialog');
}

type GreeterHooks = {
  getCharacters?: () => Array<{ isGreeter?: boolean }>;
};

/** Whether the consent greeter character is currently in the office. */
function greeterPresent(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const hooks = (window as { __pixelAgentsTestHooks?: GreeterHooks }).__pixelAgentsTestHooks;
    return (hooks?.getCharacters?.() ?? []).some((c) => c.isGreeter === true);
  });
}

/** Wait for the first-run Intro (it opens on its welcome step) and return it. */
async function openConsentDialog(frame: Frame): Promise<Locator> {
  const dialog = consentDialog(frame);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

function settingsPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'settings.json');
}

function readSettings(tmpHome: string): {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  permissions?: unknown;
} {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(tmpHome), 'utf8'));
  } catch {
    return {};
  }
}

function readConsent(tmpHome: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8');
    const consent = (JSON.parse(raw) as { hooksConsent?: Record<string, string> }).hooksConsent;
    return consent?.claude === 'granted';
  } catch {
    return false;
  }
}

function readHooksEnabled(tmpHome: string): boolean | undefined {
  try {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8');
    return (JSON.parse(raw) as { hooksEnabled?: Record<string, boolean> }).hooksEnabled?.claude;
  } catch {
    return undefined;
  }
}

/**
 * A pre-consent (legacy) settings.json: our command on 14 events, including the two we no longer collect, plus a
 * third-party hook sharing one entry. The command is matched by its `.pixel-agents/hooks/claude-hook.js` path SUFFIX
 * rather than against the resolved homedir, so a literal `/home/legacy/...` reads as ours even though the test HOME
 * is a temp dir — which is what lets this be seeded at launch time, before that temp HOME has a name.
 */
function legacyClaudeSettings(thirdPartyCommand: string): unknown {
  const command = 'node "/home/legacy/.pixel-agents/hooks/claude-hook.js"';
  const events = [
    'SessionStart',
    'SessionEnd',
    'Stop',
    'PermissionRequest',
    'Notification',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'SubagentStart',
    'SubagentStop',
    'TeammateIdle',
    'TaskCreated',
    'TaskCompleted',
  ];
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    hooks[event] = [{ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] }];
  }
  (hooks['UserPromptSubmit'] as Array<{ hooks: Array<unknown> }>)[0].hooks.unshift({
    type: 'command',
    command: thirdPartyCommand,
  });
  return { permissions: { allow: ['Bash(ls:*)'] }, hooks };
}

test.describe('Hooks consent gate', () => {
  test.use({ seedConfig: NO_CONSENT_CONFIG });

  test('fresh install: the Intro pages to the choices and Live updates writes the hooks @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    narrator.step('waiting for the first-run Intro');
    const dialog = await openConsentDialog(frame);
    await expect(dialog).toContainText('Welcome to Pixel Agents!');

    // Diegetic: a greeter character speaks the tour in a dialog box along the
    // office's foot, FULLY on screen, and the camera centres the character in
    // the office left above it. That is what makes it unmissable without an
    // office-blocking overlay.
    expect(await greeterPresent(frame)).toBe(true);
    await expect
      .poll(
        () =>
          frame.evaluate(() => {
            const el = document.querySelector('[role="dialog"]');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.left >= 0 &&
              r.top >= 0 &&
              r.right <= window.innerWidth &&
              r.bottom <= window.innerHeight
            );
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
    narrator.check('a greeter character speaks the tour; the camera centers it fully on screen');

    narrator.step('walking the tour to the choices step');
    await advanceIntroToChoices(dialog);
    // Off to start: nothing installs unless ticked.
    await expect(introChoice(dialog, 'hooks')).toHaveAttribute('aria-pressed', 'false');

    // The disclosure is the point: what is written, what data moves, how to undo —
    // in full, behind the box's Read more.
    await dialog
      .getByTestId('intro-choice-hooks')
      .getByRole('button', { name: 'Read more' })
      .click();
    // In a modal of their own, over the Intro.
    const terms = frame.getByTestId('intro-choice-terms');
    await expect(terms).toBeVisible();
    const text = (await terms.textContent()) ?? '';
    expect(text).toMatch(/adds hooks for 12 Claude Code events/);
    expect(text).toContain('~/.claude/settings.json');
    expect(text).toContain('.pixel-agents.backup');
    expect(text).toMatch(/tool inputs/);
    expect(text).toContain('127.0.0.1');
    // The LAST sentence of the disclosure — asserted at the tail so a clipped
    // or half-rendered body fails here rather than passing on its opening.
    expect(text).toContain('Instant Detection (Hooks)');
    narrator.check(
      'the consent step discloses event scope, payload destination, and how to remove',
    );
    await frame.locator('body').press('Escape');
    await expect(terms).toHaveCount(0);

    // No answer buttons beside the box: Continue sends what the boxes say.
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Not Now' })).toHaveCount(0);
    narrator.check('one box per choice and a single Continue');

    // Nothing has been written yet — the tour precedes any modification.
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);

    narrator.step('ticking Live updates and continuing');
    await chooseInIntro(dialog, { hooks: true });

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 15_000 }).toBe(12);
    expect(ourHookEvents(tmpHome)).not.toContain('UserPromptSubmit');
    expect(ourHookEvents(tmpHome)).not.toContain('TaskCreated');
    expect(readConsent(tmpHome)).toBe(true);
    narrator.check('12 events installed, prompt-forwarding events not among them');

    // The install broadcast a hooksStatus installed:true — which moots an
    // UNANSWERED ask, but must not yank the tour away from the person who just
    // answered it. The closing step is still up, after the install landed.
    await expect(dialog).toContainText("You're all set!");
    narrator.check('the closing step survived its own install broadcast');

    narrator.step("finishing the tour with Let's Go");
    await finishIntro(dialog);
    // Closing the tour despawns the greeter (matrix effect, then removal).
    await expect.poll(() => greeterPresent(frame), { timeout: 15_000 }).toBe(false);
    narrator.check('the greeter despawned once the tour ended');

    // The checkbox reflects ACTUAL install state, fed by the hooksStatus message.
    await expect
      .poll(() => getSettingChecked(frame, 'Instant Detection (Hooks)'), { timeout: 15_000 })
      .toBe(true);
    narrator.check('Settings shows Instant Detection ON');
  });

  test('Live updates left off warns first, writes nothing to ~/.claude, and persists hooks off @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);
    await advanceIntroToChoices(dialog);

    narrator.step('continuing with every box off');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog.getByTestId('intro-choices-warning')).toBeVisible();
    narrator.check('everything off is warned about before it is sent');
    await dialog.getByRole('button', { name: 'Continue Anyway' }).click();
    await expect(dialog).toContainText("You're all set!");
    // Hooks are optional: the office works without them, and the tour ends the same way.
    await finishIntro(dialog);

    await expect.poll(() => readHooksEnabled(tmpHome), { timeout: 15_000 }).toBe(false);
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    narrator.check('hooksEnabled persisted false, settings.json never created');

    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(false);
    narrator.check('Settings shows Instant Detection OFF — the checkbox tells the truth');
  });

  // The tour cannot be closed WITHOUT choosing: it has no close x, and Escape
  // does nothing. Leaving it unanswered SENDS nothing — there is no message
  // whose mishandling could turn it into an approval — and must NOT behave
  // like leaving the box off: a silently persisted hooks-off would strand the
  // user with the gate skipped forever.
  test('the tour has no close and Escape writes nothing @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);
    // Mid-tour, past the welcome.
    expect(await readIntro(dialog)).toMatch(/Pick what to turn on|only support Claude Code/);

    narrator.step('pressing Escape — no choice made');
    await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await frame.page().keyboard.press('Escape');

    // Settle: an install, had it happened, would land well inside this window.
    await frame.page().waitForTimeout(3_000);
    await expect(dialog).toBeVisible();
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    // The load-bearing half: an abort must NOT persist hooks-off, or the next
    // open skips the gate and the user is never asked again.
    expect(readHooksEnabled(tmpHome)).not.toBe(false);
    narrator.check(
      'the tour still up, settings.json never created, consent ungranted, hooks-off not persisted',
    );
  });

  // Change of mind, the honest kind: Live updates lands the hooks, Back re-opens
  // the choices step, and unticking it must UNDO the install —
  // uninstall plus persisted hooks-off. Recording the preference beside live
  // entries is the historical stranding bug (entries firing, checkbox lying,
  // gate skipped forever), so this asserts the disk, not the buttons.
  test('Back from the closing step lets unticking Live updates undo a landed install @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);
    await advanceIntroToChoices(dialog);

    narrator.step('installing, then walking back to revise');
    await chooseInIntro(dialog, { hooks: true });
    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 15_000 }).toBe(12);
    expect(readConsent(tmpHome)).toBe(true);
    narrator.check('the install landed');

    await expect(dialog).toContainText("You're all set!");
    await readIntro(dialog);
    await backInIntro(dialog, introChoice(dialog, 'hooks'));
    await expect(introChoice(dialog, 'hooks')).toHaveAttribute('aria-pressed', 'true');

    narrator.step('unticking Live updates');
    await introChoice(dialog, 'hooks').click();
    await chooseInIntro(dialog);

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => readHooksEnabled(tmpHome), { timeout: 15_000 }).toBe(false);
    narrator.check('hooks removed from disk and hooks-off persisted — a real undo');

    await finishIntro(dialog);
    // The checkbox tells the truth about the revised state.
    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(false);
    narrator.check('Settings shows Instant Detection OFF');
  });

  // The population issue #377 is about: a settings.json we refuse to touch.
  // Two things have to hold when Install fails on it.
  //
  // 1. The closing step must not congratulate. It reports the OUTCOME, not the
  //    click, or the user walks away believing hooks are running over a file
  //    that was never written.
  // 2. The ask has to be recoverable. Install records the grant BEFORE it
  //    writes, so a failed install leaves a grant with nothing on disk. A
  //    revision (the box unticked) must take that grant back.
  test.describe('when settings.json cannot be parsed', () => {
    test.use({ seedClaudeSettings: '{ "permissions": { "allow": [ "Bash(ls:*)" ]' });

    test('a failed install is reported, and unticking takes its grant back @area:cross-cutting', async ({
      pixelAgents,
    }) => {
      const { frame, tmpHome, narrator } = pixelAgents;

      const dialog = await openConsentDialog(frame);
      await advanceIntroToChoices(dialog);

      narrator.step('ticking Live updates over an unparseable settings.json');
      await chooseInIntro(dialog, { hooks: true });

      // The installer refuses to rewrite a shape it cannot read, so nothing of
      // ours reaches the file — and the closing step says so rather than
      // claiming success.
      await expect(dialog).toContainText("hooks couldn't be installed", { timeout: 15_000 });
      await expect(dialog).not.toContainText("You're all set!");
      expect(ourHookEvents(tmpHome)).toEqual([]);
      narrator.check('the closing step reports the failure instead of congratulating');

      // The user's file is exactly as they left it — not repaired, not replaced.
      expect(fs.readFileSync(settingsPath(tmpHome), 'utf8')).toBe(
        '{ "permissions": { "allow": [ "Bash(ls:*)" ]',
      );
      narrator.check('the unparseable file was left byte-for-byte alone');

      narrator.step('walking back and unticking Live updates');
      await readIntro(dialog);
      await backInIntro(dialog, introChoice(dialog, 'hooks'));
      await introChoice(dialog, 'hooks').click();
      await chooseInIntro(dialog);
      await finishIntro(dialog);

      // The load-bearing half: the grant the failed install left is taken back.
      // Keying the revert off "are hooks installed" saw nothing to undo here
      // and left a grant behind for a user whose final answer was off.
      await expect.poll(() => readConsent(tmpHome), { timeout: 15_000 }).toBe(false);
      await expect.poll(() => readHooksEnabled(tmpHome), { timeout: 15_000 }).toBe(false);
      narrator.check('the grant is revoked and hooks are off, as the final answer says');
    });
  });

  // A stray click on the office around the bubble must not read as an answer —
  // OR as an abort. This is a decision surface: only the dialog's own buttons
  // do anything at all. The office is live behind the tour (that is
  // the point of the diegetic bubble), so the most common accidental gesture —
  // clicking somewhere in the office — must leave the tour exactly where it was.
  test('clicking the office around the bubble neither answers nor dismisses @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);

    narrator.step('clicking the office beside the greeter');
    // Top-left corner of the office canvas (the dialog box draws a canvas of its own: the
    // speaker's face). force: the click lands even if some overlay pixel intercepts.
    await frame.getByTestId('office-canvas').click({ position: { x: 8, y: 8 }, force: true });
    await frame.page().waitForTimeout(1_000);

    await expect(dialog).toBeVisible();
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    expect(readHooksEnabled(tmpHome)).not.toBe(false);
    narrator.check('bubble still open, nothing written — a stray click is not an answer');
  });
});

const THIRD_PARTY = 'node /elsewhere/other-tool.js';

test.describe('Hooks consent gate / pre-consent install', () => {
  // The legacy install must exist BEFORE the extension activates — the gate
  // reads settings.json during activation, so a test-body write is too late.
  test.use({
    seedConfig: NO_CONSENT_CONFIG,
    seedClaudeSettings: legacyClaudeSettings(THIRD_PARTY),
  });

  // ZERO friction for the population that already had our hooks: no prompt at
  // all, just the migration. The reinstall only ever REDUCES scope — it drops
  // UserPromptSubmit and TaskCreated, the two events that forwarded prompt text
  // and were consumed by nothing — so a prompt would buy this user nothing they
  // do not already have. The removal route the disclosure promises is the
  // Settings toggle, exercised end-to-end by the next test.
  test('a pre-consent 14-event install migrates to 12 with no prompt @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(ourHookEvents(tmpHome)).not.toContain('UserPromptSubmit');
    expect(ourHookEvents(tmpHome)).not.toContain('TaskCreated');
    expect(readConsent(tmpHome)).toBe(true);
    // The third-party hook that shared the UserPromptSubmit entry survives.
    expect(JSON.stringify(readSettings(tmpHome))).toContain(THIRD_PARTY);
    // And the unrelated settings key nobody asked us to touch.
    expect(readSettings(tmpHome).permissions).toEqual({ allow: ['Bash(ls:*)'] });
    narrator.check('migrated to 12 events; third-party hook and unrelated keys survived');

    // The whole point: nothing was ever asked. The consent dialog stays open
    // until answered, so it would still be on screen right now — an absent
    // dialog here means none was ever raised. Two ways this fails if a prompt
    // comes back: the dialog assertion below, and the migration poll above,
    // which could not have reached 12 with the install gated behind an
    // unanswered dialog. Matched on the dialog role and again on the choices
    // step's title.
    narrator.step('checking for a consent dialog');
    await expect(consentDialog(frame)).toHaveCount(0);
    await expect(frame.getByText('Pick what to turn on')).toHaveCount(0);
    narrator.check('no consent dialog was ever raised');

    // Migrated hooks are live, and the checkbox says so.
    await expect
      .poll(() => getSettingChecked(frame, 'Instant Detection (Hooks)'), { timeout: 15_000 })
      .toBe(true);
    narrator.check('Settings shows Instant Detection ON');
  });

  // The undo route the disclosure PROMISES ("You can remove the hooks at any
  // time from Settings → Instant Detection (Hooks)"), driven for exactly the
  // population that gets no prompt. With the Remove Hooks button gone this is
  // their ONLY removal route, so it is asserted end-to-end — toggle off,
  // entries gone from disk — rather than assumed from the toggle existing.
  test('Settings toggle removes the migrated hooks and keeps third-party entries @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    // The silent migration lands first, so the toggle below is a genuine state
    // change over live hooks rather than a no-op click.
    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(true);
    narrator.check('migrated hooks installed and the checkbox reads ON');

    narrator.step('toggling Instant Detection (Hooks) OFF');
    await setSettings(frame, { hooksEnabled: false });

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 15_000 }).toBe(0);
    expect(JSON.stringify(readSettings(tmpHome))).toContain(THIRD_PARTY);
    await expect.poll(() => readHooksEnabled(tmpHome), { timeout: 15_000 }).toBe(false);
    // Removal turns hooks OFF; it does not revoke the consent the migration
    // recorded, so re-enabling later installs without re-asking.
    expect(readConsent(tmpHome)).toBe(true);
    narrator.check('our entries gone, third-party hook kept, hooks persisted off');

    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(false);
    narrator.check('Settings shows Instant Detection OFF');
  });
});

/**
 * The ordinary Settings toggle, when the uninstall CANNOT succeed.
 *
 * The preference used to be persisted before the removal was attempted, so a
 * failed uninstall stranded the user: the entries stayed on disk and kept
 * firing, while the persisted hooks-off made the next activation skip the
 * consent/install path entirely — never asked again, and the checkbox read
 * "off" so clicking it would install rather than remove.
 *
 * Consent is seeded, so this is the ordinary toggle path and not the gate. The
 * failure is forced by making ~/.claude unwritable AFTER a real install, which
 * is the state that matters: hooks genuinely installed and firing, checkbox
 * genuinely ON, and a removal that cannot land.
 */
test.describe('Hooks consent gate / toggle-off failure', () => {
  test.use({
    seedConfig: {
      vscode: { alwaysShowLabels: true, showHostDirectories: true },
      hooksConsent: { claude: 'granted' },
      officeMcpConsent: 'declined',
    },
  });

  test.skip(process.platform === 'win32', 'chmod-based write failure is not meaningful on Windows');

  test('a failed uninstall does not persist hooks-off @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;
    const claudeDir = path.join(tmpHome, '.claude');

    // Startup installed for real (consent seeded), so the checkbox is ON and
    // the toggle below is a genuine state change rather than a no-op click.
    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(true);
    narrator.check('hooks installed and the checkbox reads ON');

    const before = fs.readFileSync(settingsPath(tmpHome), 'utf8');
    try {
      fs.chmodSync(claudeDir, 0o500); // read+execute only: no write can land
      narrator.step('toggling hooks OFF while ~/.claude cannot be written');
      await setSettings(frame, { hooksEnabled: false });

      // Settle: the persist, had it happened, lands well inside this window.
      await frame.page().waitForTimeout(3_000);

      // The entries are still there and still firing...
      expect(fs.readFileSync(settingsPath(tmpHome), 'utf8')).toBe(before);
      // ...so the preference must NOT say hooks-off, or the next activation
      // skips the install path and the user is never asked again.
      expect(readHooksEnabled(tmpHome)).not.toBe(false);
      narrator.check('hooks still installed and hooksEnabled not persisted off');
    } finally {
      fs.chmodSync(claudeDir, 0o700); // or teardown cannot remove tmpHome
    }
  });
});
