import { describe, expect, it } from 'vitest';

import {
  CONSENT_DISCLOSURE,
  CONSENT_INSTALL_HEADLINE,
} from '../src/providers/hook/claude/consentCopy.js';
import {
  CLAUDE_HOOK_EVENTS,
  SETTINGS_BACKUP_SUFFIX,
} from '../src/providers/hook/claude/constants.js';

/**
 * The consent copy is two pieces because the VS Code prompt is a MODAL: the
 * headline is the message argument and the disclosure is `detail`, which
 * VS Code renders only for a modal (MessageOptions.detail). The CLI joins the
 * same two constants itself.
 *
 * These tests pin the CONTENT contract — every disclosure fact is present, and
 * it lives in the shared constants rather than in either surface's own copy.
 * They deliberately pin no length cap: `Dialog` sets `.dialog-message-detail`
 * with `innerText = options.detail` and truncates nothing (verified in
 * .vscode-test/vscode-darwin-arm64-1.129.1). The 1000-char
 * `NotificationViewItem.MAX_MESSAGE_LENGTH` applies to notifications, which
 * this prompt is not.
 */
describe('consent copy', () => {
  // The five facts the 1-star review said were missing: WHICH file is written,
  // that existing settings survive (+ where the backup goes), what data moves
  // and where it stops, and how to undo it. The event count is read from the
  // real list — a hardcoded number becomes a lie the next time it changes.
  it('carries all five disclosure facts', () => {
    const full = `${CONSENT_INSTALL_HEADLINE}\n\n${CONSENT_DISCLOSURE}`;
    expect(full).toContain('~/.claude/settings.json');
    expect(full).toContain(`${CLAUDE_HOOK_EVENTS.length.toString()} Claude Code events`);
    expect(full).toContain('Your existing settings are kept');
    expect(full).toContain(`settings.json${SETTINGS_BACKUP_SUFFIX}`);
    expect(full).toContain('tool names and tool inputs');
    expect(full).toContain('127.0.0.1');
    expect(full).toContain('Settings → Instant Detection (Hooks)');
  });

  // Every fact must be in the DISCLOSURE block, not the headline: the headline
  // is one slot of one surface, while the disclosure is what both surfaces
  // render as the body. A fact that drifted up into the headline would still
  // pass the assertion above and still reach the VS Code user, while silently
  // depending on that surface's shape.
  it('keeps every disclosure fact in the shared block, not the headline', () => {
    expect(CONSENT_DISCLOSURE).toContain(
      `${CLAUDE_HOOK_EVENTS.length.toString()} Claude Code events`,
    );
    expect(CONSENT_DISCLOSURE).toContain(`settings.json${SETTINGS_BACKUP_SUFFIX}`);
    expect(CONSENT_DISCLOSURE).toContain('tool names and tool inputs');
    expect(CONSENT_DISCLOSURE).toContain('127.0.0.1');
    expect(CONSENT_DISCLOSURE).toContain('Settings → Instant Detection (Hooks)');
  });

  // The headline asks about a FIRST install and nothing else. A user who
  // already has our hooks is migrated silently, so any "already installed"
  // wording here would be copy for a surface that no longer exists.
  it('asks about a first install, the only case that prompts', () => {
    expect(CONSENT_INSTALL_HEADLINE).toContain('needs to add its hooks');
    expect(CONSENT_INSTALL_HEADLINE).not.toContain('already installed');
    expect(CONSENT_DISCLOSURE).not.toContain('already installed');
  });

  // The disclosure keeps its paragraph breaks: it is the modal's `detail` and
  // the CLI prompt's body, and both render newlines. Collapsing it to one run
  // of prose (the shape a notification forced, since VS Code flattens a
  // notification message) would be a silent legibility regression here.
  it('is a paragraph-separated block', () => {
    expect(CONSENT_DISCLOSURE.split('\n\n')).toHaveLength(3);
  });
});
