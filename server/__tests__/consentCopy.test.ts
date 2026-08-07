import { describe, expect, it } from 'vitest';

import {
  CONSENT_DISCLOSURE,
  CONSENT_INSTALL_MESSAGE,
} from '../src/providers/hook/claude/consentCopy.js';
import {
  CLAUDE_HOOK_EVENTS,
  SETTINGS_BACKUP_SUFFIX,
} from '../src/providers/hook/claude/constants.js';

/**
 * The consent prompt is a NON-MODAL VS Code notification, and the whole reason
 * that is safe is measured here rather than assumed.
 *
 * A notification with buttons renders permanently expanded (`canCollapse` is
 * `!hasActions`, and `_expanded` is set from `actions.primary.length > 0`) with
 * no line clamp, so the only thing that can silently swallow the disclosure is
 * the length cap: `NotificationViewItem.MAX_MESSAGE_LENGTH = 1e3`, applied as
 * `substr(0, 1000) + '...'` in `parseNotificationMessage`. Verified in the
 * exact bundle this repo's e2e runs (.vscode-test/vscode-darwin-arm64-1.129.1).
 *
 * So: over the cap, the user's consent decision is made against a disclosure
 * that ends in "...". These tests are what make that a build failure instead.
 */
const VSCODE_MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;

describe('consent notification copy', () => {
  it('fits in a VS Code notification without truncation', () => {
    expect(
      CONSENT_INSTALL_MESSAGE.length,
      `Consent copy is ${CONSENT_INSTALL_MESSAGE.length.toString()} chars, over VS Code's ` +
        `NotificationViewItem.MAX_MESSAGE_LENGTH (${VSCODE_MAX_NOTIFICATION_MESSAGE_LENGTH.toString()}). ` +
        'The notification would render the tail as "..." and the user would ' +
        'approve a settings.json write against a truncated disclosure. Shorten the copy.',
    ).toBeLessThanOrEqual(VSCODE_MAX_NOTIFICATION_MESSAGE_LENGTH);
  });

  // The five facts the 1-star review said were missing: WHICH file is written,
  // that existing settings survive (+ where the backup goes), what data moves
  // and where it stops, and how to undo it. The event count is read from the
  // real list — a hardcoded number becomes a lie the next time it changes.
  it('carries all five disclosure facts', () => {
    expect(CONSENT_INSTALL_MESSAGE).toContain('~/.claude/settings.json');
    expect(CONSENT_INSTALL_MESSAGE).toContain(
      `${CLAUDE_HOOK_EVENTS.length.toString()} Claude Code events`,
    );
    expect(CONSENT_INSTALL_MESSAGE).toContain('Your existing settings are kept');
    expect(CONSENT_INSTALL_MESSAGE).toContain(`settings.json${SETTINGS_BACKUP_SUFFIX}`);
    expect(CONSENT_INSTALL_MESSAGE).toContain('tool names and tool inputs');
    expect(CONSENT_INSTALL_MESSAGE).toContain('127.0.0.1');
    expect(CONSENT_INSTALL_MESSAGE).toContain('Settings → Instant Detection (Hooks)');
  });

  // The message asks about a FIRST install and nothing else. A user who already
  // has our hooks is migrated silently, so any "already installed" wording here
  // would be copy for a surface that no longer exists.
  it('asks about a first install, the only case that prompts', () => {
    expect(CONSENT_INSTALL_MESSAGE).toContain('needs to add its hooks');
    expect(CONSENT_INSTALL_MESSAGE).not.toContain('already installed');
  });

  // Headline + the shared disclosure block, never a paraphrase: the VS Code
  // notification and the CLI prompt compose from the same constant, so neither
  // surface can drift into asking for approval on weaker terms than the other.
  it('is the shared disclosure block, not a paraphrase', () => {
    expect(CONSENT_INSTALL_MESSAGE.endsWith(CONSENT_DISCLOSURE)).toBe(true);
  });
});
