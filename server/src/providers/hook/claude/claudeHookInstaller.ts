/**
 * Install / uninstall Pixel Agents' hook entries in ~/.claude/settings.json.
 * What an entry is and which commands are ours live in claudeHookEntries.ts;
 * the guarded read-modify-write and the backup in claudeSettingsFile.ts.
 */

import { copyBundledScript } from './bundledScripts.js';
import { type ClaudeHookEntry, isOurHook, makeHookEntry } from './claudeHookEntries.js';
import {
  type ClaudeSettings,
  mutateClaudeSettings,
  readClaudeSettings,
} from './claudeSettingsFile.js';
import { CLAUDE_HOOK_EVENTS, CLAUDE_HOOK_SCRIPT_NAME } from './constants.js';

/** Surfaced when a `hooks.<Event>` field holds something other than an array.
 *  The value is malformed but it is the USER's — replacing it with `[]` (what
 *  we used to do) silently destroys hand-written config, which is the same
 *  class of bug as rewriting an unparseable file. Refuse instead. */
export function settingsNonArrayEventMessage(event: string): string {
  return `hooks.${event} in ~/.claude/settings.json is not an array — fix or remove it`;
}

/** Surfaced when `hooks` itself is not an object (an array or a scalar). Same
 *  rule one level up: writing our events onto it would either lose them
 *  silently (string keys on an array do not survive JSON.stringify) or crash
 *  with a raw TypeError. */
export const SETTINGS_HOOKS_NOT_OBJECT_MESSAGE =
  'hooks in ~/.claude/settings.json is not an object — fix or remove it';

/** Whether any command in the entry is ours (used by areHooksInstalled). */
function entryHasOurHook(entry: ClaudeHookEntry): boolean {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => isOurHook(h))
  );
}

/** "This entry held only our hooks and is now empty — drop it."
 *
 *  A unique symbol, never `null`: `null` is a value a user's settings.json can
 *  legitimately contain inside a hooks array, and using it as the sentinel made
 *  us DELETE it. Observed: `{"hooks":{"Stop":[null,"third-party-junk"]}}` — a
 *  file with no Pixel Agents command anywhere — came back rewritten as
 *  `{"hooks":{"Stop":["third-party-junk"]}}` and logged "Hooks removed". A
 *  sentinel that can collide with user data is a sentinel that eats user data;
 *  a symbol cannot appear in parsed JSON. */
const DROP_ENTRY = Symbol('drop-entry');

/** Remove our commands from an entry, preserving third-party hooks that share
 *  it. Returns the slimmed entry, or DROP_ENTRY when OUR removal emptied it.
 *  Filtering at the entry level would be wrong: an entry holds an ARRAY of
 *  hooks, and a user who hand-merged our command into their own entry must not
 *  lose theirs when we clean up ours. */
function withoutOurHooks(entry: ClaudeHookEntry): ClaudeHookEntry | typeof DROP_ENTRY {
  // Junk elements (null, a scalar, an object without a hooks array) are passed
  // through untouched rather than dereferenced: none of them can be ours, and
  // crashing on one would block install/uninstall on a file we are trying to
  // clean up.
  if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return entry;
  const kept = entry.hooks.filter((h) => !isOurHook(h));
  if (kept.length === entry.hooks.length) return entry;
  if (kept.length === 0) return DROP_ENTRY;
  return { ...entry, hooks: kept };
}

/** Strip our commands from one event's entry array. Returns the new array, or
 *  null when nothing of ours was in it (so the caller leaves the key alone —
 *  we never rewrite a field we did not author). */
function withoutOurEntries(entries: ClaudeHookEntry[]): ClaudeHookEntry[] | null {
  const filtered = entries
    .map(withoutOurHooks)
    .filter((e): e is ClaudeHookEntry => e !== DROP_ENTRY);
  // Length alone misses a slimmed shared entry (entry kept, our command removed
  // from inside it) — compare content.
  return JSON.stringify(filtered) === JSON.stringify(entries) ? null : filtered;
}

/**
 * Whether ANY Pixel Agents hook command is present in ~/.claude/settings.json.
 *
 * "Any", not "all 12", and the difference is the whole point. Every caller asks
 * this question for one of two reasons — "are our hooks firing right now?"
 * (the consent gate) or "does the checkbox say hooks are installed?"
 * (`hooksStatus`) — and a hook fires whether or not its eleven siblings are
 * there. An all-or-nothing answer made a partial or textually unrecognized
 * install read as "nothing installed": the checkbox showed OFF while hooks
 * fired, "Not Now" left them firing without saying so, and "Don't Ask Again"
 * persisted hooks-off without removing anything — the exact stranded state
 * this gate exists to prevent.
 *
 * The walk covers EVERY event key, not just the ones we currently install: a
 * legacy install's leftovers under an unlisted event fire too, and uninstall
 * already walks all keys (they must agree, or "remove" would leave behind
 * something this reports as absent).
 *
 * Completeness is not lost information — the install path is idempotent and
 * runs on every consented startup, so a partial install repairs itself the
 * moment consent exists. What it cannot repair is a user who was never told.
 *
 * An unparseable file reads as "not installed" — the install path will then
 * refuse to touch it rather than rewrite it.
 */
export function areHooksInstalled(): boolean {
  let settings: ClaudeSettings;
  try {
    settings = readClaudeSettings();
  } catch {
    return false;
  }
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  return Object.values(hooks).some(
    (entries) => Array.isArray(entries) && entries.some(entryHasOurHook),
  );
}

/**
 * Install Pixel Agents hook entries into ~/.claude/settings.json for
 * Notification, Stop, and PermissionRequest events. Idempotent: removes
 * any existing Pixel Agents entries before adding fresh ones.
 *
 * Rejects (before any write) when settings.json exists but cannot be parsed or
 * keeps changing concurrently — callers surface the error to the user instead
 * of installing.
 */
export async function installHooks(): Promise<void> {
  let wrote: boolean;
  try {
    wrote = await installEntries();
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — hooks not installed.`, {
      cause: e,
    });
  }
  if (wrote) {
    console.log('[Pixel Agents] Hooks installed in ~/.claude/settings.json');
  }
}

function installEntries(): Promise<boolean> {
  return mutateClaudeSettings((settings) => {
    if (settings.hooks === undefined || settings.hooks === null) {
      settings.hooks = {};
    } else if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      // The container itself is malformed. Assigning event keys onto an ARRAY
      // silently loses them (JSON.stringify emits only numeric indices), so the
      // write would commit, log "Hooks installed", and report installed:true
      // over a file with no hooks in it. A scalar crashes with a raw TypeError.
      // Refuse, like a non-array event value one level down.
      throw new Error(SETTINGS_HOOKS_NOT_OBJECT_MESSAGE);
    }
    const hooks = settings.hooks;
    let changed = false;

    // Migration sweep FIRST: strip our commands from every event we no longer
    // install. The per-event loop below only touches listed events, so without
    // this a legacy install (which included UserPromptSubmit and TaskCreated)
    // would keep forwarding prompt text and task payloads forever — the users
    // with the widest install would be the only ones never migrated.
    const listed = new Set<string>(CLAUDE_HOOK_EVENTS);
    for (const event of Object.keys(hooks)) {
      if (listed.has(event)) continue;
      const entries = hooks[event];
      // A non-array under an event we do NOT install is the user's alone (a
      // future Claude event, a hand-written shape). We have nothing of ours to
      // strip from it, so passing it through untouched IS the whole obligation
      // — refusing here would block install on a key that costs us nothing.
      // The listed-event branch below is the one a non-array actually blocks,
      // and there we throw rather than normalize.
      if (!Array.isArray(entries)) continue;
      const filtered = withoutOurEntries(entries);
      if (filtered === null) continue;
      changed = true;
      // Only remove the key when OUR removal emptied it. An event the user
      // left empty on their own is theirs to keep — same rule uninstallHooks
      // follows, and the same reason we never rewrite fields we did not author.
      if (filtered.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = filtered;
      }
    }

    for (const event of CLAUDE_HOOK_EVENTS) {
      const existing = hooks[event];
      if (existing === undefined) {
        hooks[event] = [];
      } else if (!Array.isArray(existing)) {
        // The value is malformed but it is the USER's. Replacing it with []
        // (what we used to do) silently destroys hand-written config — the
        // same class of bug as rewriting an unparseable file. Refuse: the
        // throw propagates out of the mutate callback and installHooks wraps
        // it with "— hooks not installed."
        throw new Error(settingsNonArrayEventMessage(event));
      }
      const entries = hooks[event];
      // Remove any existing Pixel Agents commands (in case the script path changed)
      const filtered = (withoutOurEntries(entries) ?? entries).concat(makeHookEntry());
      if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
        hooks[event] = filtered;
        changed = true;
      }
    }
    return changed;
  });
}

/** Remove all Pixel Agents hook entries from ~/.claude/settings.json. Cleans up empty objects.
 *  Rejects (before any write) when the file cannot be parsed — same protection
 *  as install: never rewrite a file we could not read. Callers surface the
 *  error; claiming success after an aborted uninstall is how a "removed"
 *  log line ends up next to entries that are still live. */
export async function uninstallHooks(): Promise<void> {
  let wrote: boolean;
  try {
    wrote = await mutateClaudeSettings((settings) => {
      if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
        return false;
      }
      const hooks = settings.hooks;
      let changed = false;
      for (const event of Object.keys(hooks)) {
        const entries = hooks[event];
        if (!Array.isArray(entries)) continue;
        const filtered = withoutOurEntries(entries);
        if (filtered === null) continue;
        changed = true;
        // Remove the key only when OUR removal emptied it. An event the user
        // left empty themselves is theirs to keep — same rule as installEntries'
        // migration sweep, and the same reason we never rewrite what we did not
        // author.
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
      }
      if (changed && Object.keys(hooks).length === 0) {
        delete settings.hooks;
      }
      return changed;
    });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — hook entries left in place.`, {
      cause: e,
    });
  }
  if (wrote) {
    console.log('[Pixel Agents] Hooks removed from ~/.claude/settings.json');
  }
}

/** Copy the shipped hook script from the extension to ~/.pixel-agents/hooks/.
 *  Returns true if the script was copied, false if the source was missing or the
 *  copy failed, so callers can report the failure instead of logging a false
 *  success (issue #333: a path regression silently installed nothing). */
export function copyHookScript(extensionPath: string): boolean {
  return copyBundledScript(extensionPath, CLAUDE_HOOK_SCRIPT_NAME);
}
