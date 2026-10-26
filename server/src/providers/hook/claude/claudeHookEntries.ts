/**
 * Our hook entries in ~/.claude/settings.json, as data: what install writes
 * (makeHookEntry — the WRITER), which commands are ours (isOurHookCommand, the
 * identity rule), and whether a `hooks` value is nothing but our output
 * (hooksHoldOnlyOurs, the hooks half of the backup predicate). Pure — no file
 * access — so the settings file module can ask it without importing the
 * installer that writes through it.
 */

import { isDeepStrictEqual } from 'util';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { bundledScriptPath } from './bundledScripts.js';
import { commandRunsScript } from './commandIdentity.js';
import { CLAUDE_HOOK_SCRIPT_NAME, LEGACY_HOOK_SCRIPT_NAME } from './constants.js';

/** A single hook entry in Claude Code's ~/.claude/settings.json hooks config. */
export interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
  }>;
}

/** Legacy script name (before rename to claude-hook.js), as a path suffix. */
const LEGACY_HOOK_PATH_SUFFIX = `/${LEGACY_HOOK_SCRIPT_NAME}`;

/** The path suffix we own: `/.pixel-agents/hooks/claude-hook.js`. The leading
 *  separator is load-bearing — without it `/opt/evil.pixel-agents/hooks/...`
 *  and `my-pixel-agents-hook.js` match by substring. */
const HOOK_PATH_SUFFIX = `/${HOOK_SCRIPTS_DIR}/${CLAUDE_HOOK_SCRIPT_NAME}`;

/**
 * Check if a single hook command is ours.
 *
 * Neither half of the path is identity on its own: `claude-hook.js` is a
 * generic name another Claude tool could plausibly use, and substring tests
 * claim unrelated commands. Empirically, plain `includes` classified all of
 * these as ours — and `uninstallHooks` then DELETED them:
 *   node /opt/.pixel-agents/hooks/claude-hook.js.backup   (a different file)
 *   true # /opt/.pixel-agents/hooks/claude-hook.js        (a comment)
 *   wrapper --note=".pixel-agents/hooks/claude-hook.js" x (an argument)
 *   node /opt/evil.pixel-agents/hooks/claude-hook.js      (no token boundary)
 *   node /opt/my-pixel-agents-hook.js.bak                 (legacy, no boundary)
 * Deleting a third-party hook is the same "we destroyed the user's config"
 * class of bug this whole module exists to fix, so identity is anchored at
 * BOTH ends: our path suffix must start at a path separator and must END the
 * command's script token.
 *
 * Deliberate scope choices:
 * - Casing is NOT significant: the token is normalized to lower case before the
 *   suffix compare. macOS and Windows — the two GUI platforms this ships on —
 *   have case-insensitive volumes, where `/home/x/.Pixel-Agents/Hooks/Claude-Hook.js`
 *   is the SAME INODE as our script and is genuinely firing. Reading it as
 *   foreign is what shipped: reinstall appended a duplicate (both fired), and
 *   uninstall left the cased entry behind as an orphan our own uninstall could
 *   no longer see — a running hook the user has no route to remove. The folding
 *   is UNCONDITIONAL (we do not probe the filesystem's case sensitivity), so the
 *   accepted residual is a Linux-only false positive that is NOT harmless: on a
 *   case-sensitive volume `~/.Pixel-Agents/hooks/claude-hook.js` is a genuinely
 *   DIFFERENT file, we classify it as ours, and uninstall DELETES it — the same
 *   class of loss this module exists to prevent, traded knowingly against a
 *   guaranteed unremovable live hook on the two platforms that actually ship
 *   here (see the removal pinned in claudeHookInstaller.test.ts). Nothing we or
 *   Claude Code write ever creates that path. The blast radius is bounded by the
 *   rest of the anchoring: a third-party hook differing in more than case is
 *   still untouched.
 * - The FIRST token only. A command is `node <script>` or `<script>`; our path
 *   appearing later is an argument or a comment, not the thing being run.
 * - ABSOLUTE paths only. We always write one, and a RELATIVE
 *   `.pixel-agents/hooks/claude-hook.js` resolves against whatever directory
 *   Claude Code happens to run in — so it names a project-local file that is
 *   almost certainly not ours, and deleting it would be the same mistake as
 *   deleting a lookalike.
 * - Suffix, not the resolved homedir: an entry written under a previous or
 *   moved HOME is still ours to clean up.
 * - A symlink ALIAS pointing at our script is not recognized (we compare text,
 *   never resolve). That direction is safe — a later install appends the
 *   canonical command next to the alias, so the worst case is one duplicate
 *   execution for a user who hand-aliased us, versus deleting a stranger's
 *   hook for everyone if we resolved paths from a config file.
 */
export function isOurHookCommand(command: string): boolean {
  // Both suffix constants are lower-case, as commandRunsScript requires.
  return commandRunsScript(command, [HOOK_PATH_SUFFIX, LEGACY_HOOK_PATH_SUFFIX]);
}

/** A single hook object is ours. Tolerates junk elements (null, scalars) —
 *  none of them can be ours, and they must not crash the scan. */
export function isOurHook(hook: ClaudeHookEntry['hooks'][number]): boolean {
  return (
    hook !== null &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    isOurHookCommand(hook.command)
  );
}

/** Build the shell command that Claude Code will execute for each hook event. */
function makeHookCommand(): string {
  const scriptPath = bundledScriptPath(CLAUDE_HOOK_SCRIPT_NAME);
  return `node "${scriptPath}"`;
}

/** Create a hook entry object for Claude's settings.json. Matcher is empty (catch-all). */
export function makeHookEntry(): ClaudeHookEntry {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: makeHookCommand(),
        timeout: 5,
      },
    ],
  };
}

/** Whether a `hooks` value is exactly what our installer writes, running our
 *  script — the hooks half of the backup predicate (settingsHoldOnlyOurOutput
 *  in claudeSettingsFile.ts, which holds the full rule).
 *
 *  "Exactly the shape our installer writes" is checked against the WRITER —
 *  makeHookEntry() is the reference the fields are compared to — not against a
 *  second hand-written description of it. A hand-rolled twin drifts: the next
 *  field added to the entries we write would make this predicate read our own
 *  fresh output as user content, silently reviving the backup-of-our-own-file
 *  bug for every install after it. Two fields are exempt from the comparison
 *  because PAST installs legitimately differ in them: `command` (the script
 *  path moves between homes and versions — identity is isOurHook, the same
 *  suffix rule used everywhere else) and `timeout`. Deviation in anything
 *  else, present or added later, reads as the user's. */
export function hooksHoldOnlyOurs(hooks: unknown): boolean {
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return false;
  }
  const reference = makeHookEntry();
  // Maps rather than index access: `has` distinguishes "the writer has no such
  // field" (an unknown field on the entry — not ours) from "the writer's value
  // is undefined", and neither needs a cast to an index-signature type.
  const referenceFields = new Map<string, unknown>(Object.entries(reference));
  const referenceHookFields = new Map<string, unknown>(Object.entries(reference.hooks[0]));
  // isDeepStrictEqual, not stringify-compare: two objects a user's editor
  // wrote with keys in a different order are the same VALUE, and key order is
  // not part of a value.
  const matchesWriter = (fields: Map<string, unknown>, key: string, value: unknown): boolean =>
    fields.has(key) && isDeepStrictEqual(value, fields.get(key));

  for (const entries of Object.values(hooks as Record<string, ClaudeHookEntry[]>)) {
    // An empty event array is not ours: install always fills the key it adds,
    // and uninstall deletes a key its own removal emptied.
    if (!Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'hooks') continue; // compared hook-by-hook below
        if (!matchesWriter(referenceFields, key, value)) return false;
      }
      if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) return false;
      for (const hook of entry.hooks) {
        if (!isOurHook(hook)) return false;
        for (const [key, value] of Object.entries(hook)) {
          if (key === 'command' || key === 'timeout') continue; // vary across installs
          if (!matchesWriter(referenceHookFields, key, value)) return false;
        }
      }
    }
  }
  return true;
}
