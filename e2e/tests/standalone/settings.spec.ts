import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { openSettingsModal } from '../../helpers/webview';

// Settle window before a negative assertion (see e2e/helpers/office.ts
// wait-strategy conventions): the blur handler is synchronous but a server
// round trip is not, so give the wrong outcome a chance to render before
// asserting it is absent.
const NEGATIVE_SETTLE_MS = 750;

// A relative path is rejected by the client-side pre-check on every platform
// (path.isAbsolute is false for it on both POSIX and win32), so the same
// literal works as the rejection case on all three CI hosts.
const RELATIVE_PATH = 'relative/path';

// Windows-shaped absolute paths. These must survive the CLIENT-side
// pre-check; whether the SERVER accepts them depends on the host it runs on
// (path.isAbsolute('C:\\...') is false on POSIX), which is why the Windows
// half of the third test asserts only on the inline error.
const WINDOWS_BACKSLASH_PATH = 'C:\\claude-profiles\\work';
const WINDOWS_FORWARD_SLASH_PATH = 'C:/Users/me/.claude-alt';

test.describe('Standalone / settings', () => {
  // The default branch of the resolver chain (setting -> $CLAUDE_CONFIG_DIR ->
  // ~/.claude). The standalone fixture spawns the CLI with HOME pinned to its
  // own tmpHome and CLAUDE_CONFIG_DIR stripped (see applyMockHomeEnv), so the
  // server must resolve to <tmpHome>/.claude and label the source "default".
  test('Claude config directory reports the resolved default @area:standalone', async ({
    page,
    standalone,
  }) => {
    const modal = await openSettingsModal(page);
    const defaultDir = path.join(standalone.tmpHome, '.claude');

    // Proof that settingsLoaded carried all of resolvedClaudeConfigDir +
    // resolvedClaudeConfigDirSource into the field's helper line.
    await expect(modal.getByText(`Using ${defaultDir} (default)`)).toBeVisible();

    // Nothing overridden: the input is blank and no restart is pending.
    await expect(modal.getByLabel('Claude config directory')).toHaveValue('');
    await expect(modal.getByText('Restart Pixel Agents to apply')).toHaveCount(0);
  });

  // The save round trip: setClaudeConfigDir -> normalizeClaudeConfigDirInput
  // -> claudeConfigDirUpdated -> the field re-hydrates from the server's
  // answer. The typed value carries a redundant `nested/..` segment so the
  // value that comes back proves it went through the SERVER's normalizer and
  // is not just the keystrokes still sitting in the input.
  test('Claude config directory override round-trips and asks for a restart @area:standalone', async ({
    page,
    standalone,
  }) => {
    const modal = await openSettingsModal(page);
    const input = modal.getByLabel('Claude config directory');
    const defaultDir = path.join(standalone.tmpHome, '.claude');

    await expect(modal.getByText(`Using ${defaultDir} (default)`)).toBeVisible();
    await standalone.drainMessages();

    // workspaceDir exists on disk, so the "this directory does not exist yet"
    // sub-clause stays out of the restart notice and the assertion below can
    // match the notice text exactly.
    const rawInput = `${standalone.workspaceDir}${path.sep}nested${path.sep}..`;
    await input.fill(rawInput);
    await input.blur();

    await expect(input).toHaveValue(standalone.workspaceDir);
    await expect(modal.getByText('Restart Pixel Agents to apply', { exact: true })).toBeVisible();

    // The override is persisted but NOT live — the module-level override is
    // set once at boot — so the helper line must still report the default.
    // That gap is exactly what the restart notice above is announcing.
    await expect(modal.getByText(`Using ${defaultDir} (default)`)).toBeVisible();

    const messages = await standalone.drainMessages();
    expect(
      messages.some(
        (message) =>
          message.type === 'claudeConfigDirUpdated' &&
          message.claudeConfigDir === standalone.workspaceDir,
      ),
    ).toBe(true);
  });

  // Regression guard for the client-side pre-check. It used to accept only
  // POSIX roots, which silently rejected every Windows absolute path a
  // Windows user could type into this field. The rejection half runs first so
  // the acceptance half has a proven-live error element to disappear from —
  // otherwise "no error is shown" could pass simply because the blur handler
  // never ran.
  test('Claude config directory rejects a relative path and accepts Windows paths @area:standalone', async ({
    page,
    standalone,
  }) => {
    const modal = await openSettingsModal(page);
    const input = modal.getByLabel('Claude config directory');
    const inlineError = modal.locator('.text-status-error');
    await standalone.drainMessages();

    await input.fill(RELATIVE_PATH);
    await input.blur();
    await expect(inlineError).toHaveText('Must be an absolute path');

    // Rejected client-side means no wire traffic at all: the value is neither
    // sent nor echoed back, so the input still holds the raw keystrokes.
    await page.waitForTimeout(NEGATIVE_SETTLE_MS);
    const messages = await standalone.drainMessages();
    expect(messages.some((message) => message.type === 'claudeConfigDirUpdated')).toBe(false);
    await expect(input).toHaveValue(RELATIVE_PATH);

    for (const windowsPath of [WINDOWS_BACKSLASH_PATH, WINDOWS_FORWARD_SLASH_PATH]) {
      await input.fill(windowsPath);
      await input.blur();
      await page.waitForTimeout(NEGATIVE_SETTLE_MS);
      await expect(inlineError).toHaveCount(0);
    }
  });
});
