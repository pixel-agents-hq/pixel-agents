import fs from 'node:fs';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { getSettingChecked, setSettings } from '../../../helpers/webview';

/**
 * First-run consent for modifying ~/.claude/settings.json.
 *
 * Every other spec seeds `hooksConsentGiven: true` (e2e/helpers/launch.ts) so
 * hooks flow without a prompt. These specs opt OUT via `seedConfig`: a config
 * without the key parses to false (server/src/configPersistence.ts), which is
 * exactly what a real first run looks like.
 *
 * The prompt is a non-modal notification, and these specs drive it through the
 * notification CENTER rather than the toast — see openConsentNotification for
 * why the toast is not a usable surface here.
 *
 * The gate is the answer to a 1-star Marketplace review: Pixel Agents replaced
 * a user's whole settings.json with no prompt, no backup, and no disclosure.
 * These tests assert the on-disk consequences of each choice, not just that a
 * prompt appeared.
 */

const NO_CONSENT_CONFIG = {
  vscode: { alwaysShowLabels: true },
  standalone: { alwaysShowLabels: true },
  // hooksConsentGiven deliberately absent -> parses to false -> prompt shows.
};

/**
 * Open the notifications center (the statusbar bell) and return our consent
 * notification's row.
 *
 * The toast is not a usable surface for these specs, for two independent
 * reasons: the harness hides `.notifications-toasts` for the whole session
 * (video stability, e2e/helpers/webview.ts), and an Info toast auto-purges to
 * the bell after ~10 s anyway, which races multi-second fixture setup. Purging
 * does NOT close the notification — it parks in the center, fully expanded with
 * its buttons, until it is answered. The center is live-bound to the
 * notifications model, so a prompt that fires after the click still shows up.
 */
async function openConsentNotification(window: Page): Promise<Locator> {
  await window.locator('.statusbar-item[id="status.notifications"]').click();
  const row = window
    .locator('.notifications-center .notification-list-item')
    .filter({ hasText: 'Pixel Agents' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
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

/** Events carrying one of our hook commands. */
function ourHookEvents(tmpHome: string): string[] {
  const hooks = readSettings(tmpHome).hooks ?? {};
  return Object.entries(hooks)
    .filter(([, entries]) =>
      (entries ?? []).some((entry) =>
        (entry.hooks ?? []).some((h) => h.command?.includes('.pixel-agents/hooks/claude-hook.js')),
      ),
    )
    .map(([event]) => event)
    .sort();
}

function readConsent(tmpHome: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8');
    return (JSON.parse(raw) as { hooksConsentGiven?: boolean }).hooksConsentGiven === true;
  } catch {
    return false;
  }
}

function readHooksEnabled(tmpHome: string): boolean | undefined {
  try {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8');
    return (JSON.parse(raw) as { vscode?: { hooksEnabled?: boolean } }).vscode?.hooksEnabled;
  } catch {
    return undefined;
  }
}

/**
 * A pre-consent (legacy) settings.json: our command on 14 events, including the
 * two we no longer collect, plus a third-party hook sharing one entry.
 *
 * The hook command is matched by its `.pixel-agents/hooks/claude-hook.js` path
 * SUFFIX, not against the resolved homedir, so a literal `/home/legacy/...`
 * path is recognized as ours even though the test HOME is a temp dir. That is
 * what lets this be seeded at launch time, before the temp HOME's name exists.
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

  test('fresh install: the prompt discloses scope and Install writes the hooks @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window, frame, tmpHome, narrator } = pixelAgents;

    narrator.step('waiting for the first-run consent notification');
    const prompt = await openConsentNotification(window);

    // The disclosure is the point: what is written, what data moves, how to undo.
    const text = (await prompt.textContent()) ?? '';
    expect(text).toContain('~/.claude/settings.json');
    expect(text).toMatch(/12 Claude Code events/);
    expect(text).toContain('.pixel-agents.backup');
    expect(text).toMatch(/tool inputs/);
    expect(text).toContain('127.0.0.1');
    // The LAST sentence of the disclosure. VS Code truncates a notification
    // message at 1000 chars with a trailing "...", so asserting the tail is what
    // proves the whole disclosure reached the decision surface un-clipped —
    // the property the modal used to make moot.
    expect(text).toContain('Instant Detection (Hooks)');
    narrator.check('notification discloses event scope, payload destination, and how to remove');

    // Nothing has been written yet — the prompt precedes any modification.
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);

    narrator.step('clicking Install Hooks');
    await prompt.getByRole('button', { name: 'Install Hooks' }).click();

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 15_000 }).toBe(12);
    expect(ourHookEvents(tmpHome)).not.toContain('UserPromptSubmit');
    expect(ourHookEvents(tmpHome)).not.toContain('TaskCreated');
    expect(readConsent(tmpHome)).toBe(true);
    narrator.check('12 events installed, prompt-forwarding events not among them');

    // The checkbox reflects ACTUAL install state, fed by the hooksStatus message.
    await expect
      .poll(() => getSettingChecked(frame, 'Instant Detection (Hooks)'), { timeout: 15_000 })
      .toBe(true);
    narrator.check('Settings shows Instant Detection ON');
  });

  test('Not Now writes nothing and leaves consent ungranted @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window, frame, tmpHome, narrator } = pixelAgents;

    const prompt = await openConsentNotification(window);

    narrator.step('declining with Not Now');
    await prompt.getByRole('button', { name: 'Not Now' }).click();
    // Answering closes the notification, in the center as well as the toast.
    await expect(prompt).toBeHidden({ timeout: 15_000 });

    // Settle: an install, had it happened, would land well inside this window.
    await window.waitForTimeout(3_000);
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    // Not Now persists nothing — the user is asked again next start.
    expect(readHooksEnabled(tmpHome)).not.toBe(false);
    narrator.check('settings.json never created, consent still ungranted');

    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(false);
    narrator.check('Settings shows Instant Detection OFF — the checkbox tells the truth');
  });

  test("Don't Ask Again writes nothing and persists hooks off @area:cross-cutting", async ({
    pixelAgents,
  }) => {
    const { window, tmpHome, narrator } = pixelAgents;

    const prompt = await openConsentNotification(window);

    narrator.step("declining permanently with Don't Ask Again");
    await prompt.getByRole('button', { name: "Don't Ask Again" }).click();
    await expect(prompt).toBeHidden({ timeout: 15_000 });

    await expect.poll(() => readHooksEnabled(tmpHome), { timeout: 15_000 }).toBe(false);
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    narrator.check('hooksEnabled persisted false, settings.json untouched');
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
    const { window, frame, tmpHome, narrator } = pixelAgents;

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(ourHookEvents(tmpHome)).not.toContain('UserPromptSubmit');
    expect(ourHookEvents(tmpHome)).not.toContain('TaskCreated');
    expect(readConsent(tmpHome)).toBe(true);
    // The third-party hook that shared the UserPromptSubmit entry survives.
    expect(JSON.stringify(readSettings(tmpHome))).toContain(THIRD_PARTY);
    // And the unrelated settings key nobody asked us to touch.
    expect(readSettings(tmpHome).permissions).toEqual({ allow: ['Bash(ls:*)'] });
    narrator.check('migrated to 12 events; third-party hook and unrelated keys survived');

    // The whole point: nothing was ever asked. Opening the center is what makes
    // this a real assertion rather than a check against a surface that is not
    // there — a consent notification parks in the center, fully expanded, until
    // it is answered, so an absent row here means no prompt was raised. Matched
    // on the tail of the shared disclosure block, which EVERY consent variant
    // carries, so a re-introduced prompt of any wording fails this.
    narrator.step('checking the notification center for a consent prompt');
    await window.locator('.statusbar-item[id="status.notifications"]').click();
    await expect(window.locator('.notifications-center')).toBeVisible({ timeout: 15_000 });
    await expect(
      window
        .locator('.notifications-center .notification-list-item')
        .filter({ hasText: /remove the hooks at any time/i }),
    ).toHaveCount(0);
    narrator.check('no consent notification was ever raised');
    await window.keyboard.press('Escape'); // the center must not cover the panel

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
  test.use({ seedConfig: { vscode: { alwaysShowLabels: true }, hooksConsentGiven: true } });

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
