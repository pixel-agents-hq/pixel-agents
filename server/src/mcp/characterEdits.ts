/**
 * Agents' Character edits as the office keeps them: the ONE place an
 * edit_characters batch is committed, undone, or refused because a person is
 * editing — the layout edits' twin (layoutEdits.ts).
 *
 * - **Commit**: a batch (characterEditOps.ts) that applied is saved through the
 *   Characters view's own Save path (characterProfilesPersistence.ts
 *   commitCharacterProfiles: validate, write, renumber agents' looks and the
 *   shared references, broadcast `characterProfilesLoaded` without a saveId so
 *   every office takes it as a foreign list), then the Directories' default
 *   characters it changed in one config write, then the Directories (and the
 *   roster's recency) re-sent to every office. All or nothing: when the
 *   Directory write fails after the roster landed, the roster it replaced is
 *   put back (`putBack`, undo's own step) and the edit reports nothing changed.
 *
 *   A delete moves every palette index after it, and Directory defaults are
 *   palette indices. The roster save renumbers every Directory first (dropping
 *   the deleted character, as a hand save does); the batch's own Directory
 *   writes come after it, already in the new roster's indices (the ops held
 *   them by id), so they land on top of the renumbered config as the final word.
 * - **Editing lock**: each office reports whether its Characters view holds an
 *   unsaved draft (`charactersEditing {dirty}`, keyed by its socket, dropped
 *   when the socket goes). While any does, edits and undo are refused: an
 *   agent never overwrites a person's work, and the person's Save would
 *   overwrite the agent's.
 * - **Undo**: the last CHARACTER_UNDO_DEPTH agent edits, each with the roster
 *   it replaced and wrote and every Directory whose defaults it changed (the
 *   batch's own and the ones its roster save renumbered), before and after.
 *   Undo restores the newest only while the roster and those Directories still
 *   hold exactly what it wrote; anything since — a Characters-view Save, a
 *   Directory saved by hand — refuses it. Putting the roster back goes through
 *   the same save path, so agents' looks and the shared references are
 *   renumbered back; each touched Directory's defaults are then written on top,
 *   giving exactly the state before the edit. (The roster's recency is not
 *   kept: an undone delete brings the character back, not its place in it.)
 *   undo_character_edit and the Characters view's "Undo <agent>'s edit"
 *   (`undoAgentCharacterEdit`) are this same operation; every office is told
 *   what an undo would revert (`agentCharacterEditStatus`), and when an edit
 *   lands (`landed`, the view's status line names the agent).
 */

import { characterIdOf, type CharacterProfile } from '../../../core/src/characterProfiles.js';
import type { CharacterRenderer } from '../../../core/src/characters/renderer.js';
import type { AgentCharacterEditStatus } from '../../../core/src/messages.js';
import { CHARACTER_SUMMARY_NAMES, CHARACTER_UNDO_DEPTH } from '../constants.js';
import { canonicalJson } from './canonicalJson.js';
import {
  applyCharacterOps,
  type CharacterOp,
  type EditDirectory,
  type EditedCharacter,
} from './characterEditOps.js';

export interface CharacterEditsDeps {
  /** The roster as saved (characters.json, or the defaults). */
  profiles(): CharacterProfile[];
  /** The renderer, with the custom wardrobe items. */
  renderer(): CharacterRenderer;
  /** Every Directory of the office, the user's own with their default characters. */
  directories(): EditDirectory[];
  /** Save a roster through the Characters view's Save path; false when it was refused. */
  commitProfiles(profiles: CharacterProfile[]): boolean;
  /** Set user Directories' default characters in one write; false when it failed. */
  writeDirectoryCharacters(
    writes: ReadonlyArray<{ path: string; characters: readonly number[] }>,
  ): boolean;
  /** The Directories (their defaults) and the roster's recency changed: re-send them. Called
   *  after the edit's own Directory writes; `commitProfiles` re-sends what its save renumbered. */
  characterRefsChanged(): void;
  /** How the office names an agent ("Undo <name>'s edit"): agentLabel.ts. */
  agentName(agentId: number): string;
  /** Send a message to every open office. */
  broadcast(message: Record<string, unknown>): void;
}

/** An edit_characters call's outcome, in the tool's terms. */
export type CharacterEditOutcome =
  | {
      ok: true;
      changed: boolean;
      created: EditedCharacter[];
      updated: EditedCharacter[];
      deleted: EditedCharacter[];
      /** Each Directory whose defaults the batch changed, and its defaults now (palette indices). */
      directories: Array<{ directory: string; characters: number[] }>;
      notes: string[];
    }
  | {
      ok: false;
      reason: string;
      index?: number;
      /** Something may have changed after all (a rollback that failed too). */
      partial?: true;
    };

/** An undo's outcome: whose edit, what it did, and what was put back. */
export type CharacterUndoOutcome =
  | {
      ok: true;
      agentId: number;
      agentName: string;
      /** What the undone edit did ("created Naruto"). */
      summary: string;
      /** Characters the edit deleted or changed, back as they were (ids). */
      restored: string[];
      /** Characters the edit created, gone again. */
      removed: Array<{ id: string; name: string }>;
      /** Each Directory whose defaults were put back, and its defaults now (palette indices). */
      directories: Array<{ directory: string; characters: number[] }>;
    }
  | { ok: false; reason: string };

/** One Directory's default characters (palette indices) before and after an edit. */
export interface DirectoryDefaultsChange {
  path: string;
  name: string;
  before: number[];
  after: number[];
}

/** One committed agent Character edit: what it replaced and what it wrote. */
export interface CharacterEditEntry {
  agentId: number;
  /** The agent's name when it edited (it may have left since). */
  agentName: string;
  /** What it did, in a few words ("created Naruto, deleted Dress"). */
  summary: string;
  roster: { before: CharacterProfile[]; after: CharacterProfile[] };
  /** Every Directory whose defaults changed with the edit (the batch's and the renumbered). */
  directories: DirectoryDefaultsChange[];
}

export interface CharacterEdits {
  /** Apply an agent's batch: all or none, saved once, shown in every office. */
  edit(agentId: number, ops: readonly CharacterOp[]): CharacterEditOutcome;
  /** Restore the roster and Directories before the newest agent edit, if nothing changed since. */
  undo(): CharacterUndoOutcome;
  /** An office reports whether its Characters view holds an unsaved draft. */
  setEditing(client: object, dirty: boolean): void;
  /** An office's socket went: its report goes with it. */
  clientGone(client: object): void;
  /** What an undo would revert now (agentCharacterEditStatus), for the connect snapshot. */
  statusMessage(): AgentCharacterEditStatus;
  /** The roster or a Directory was saved by other means: what an undo would revert may have changed. */
  charactersChanged(): void;
  /** The committed agent edits, oldest first (at most CHARACTER_UNDO_DEPTH). */
  history(): readonly CharacterEditEntry[];
}

export const CHARACTERS_EDITING_REASON =
  'Someone has unsaved changes in the Characters view, so the roster is locked. ' +
  'Try again once they save or discard them (or ask the user to).';

/** A state to put back: a roster, and Directories' defaults (palette indices of that roster). */
interface CharacterState {
  roster: CharacterProfile[];
  directories: ReadonlyArray<{ path: string; characters: readonly number[] }>;
}

/** How putting a state back went: done, refused before anything changed, or the roster
 *  went back but the Directories did not. */
type PutBack = 'done' | 'roster-failed' | 'directories-failed';

export function createCharacterEdits(deps: CharacterEditsDeps): CharacterEdits {
  const dirtyClients = new Set<object>();
  const history: CharacterEditEntry[] = [];
  let lastStatus = '';

  /** Every user Directory's defaults, by path. */
  const defaultsByPath = (): Map<string, { name: string; characters: number[] }> =>
    new Map(
      deps
        .directories()
        .flatMap((d) =>
          d.characters ? [[d.path, { name: d.name, characters: [...d.characters] }] as const] : [],
        ),
    );

  /** The Directories whose defaults differ between two readings, before and after. */
  function defaultsChanges(
    before: Map<string, { name: string; characters: number[] }>,
    after: Map<string, { name: string; characters: number[] }>,
  ): DirectoryDefaultsChange[] {
    const changes: DirectoryDefaultsChange[] = [];
    for (const [path, now] of after) {
      const was = before.get(path)?.characters ?? [];
      if (!sameList(was, now.characters)) {
        changes.push({ path, name: now.name, before: was, after: now.characters });
      }
    }
    return changes;
  }

  /**
   * Put a roster and Directories' defaults back: the roster through the save path
   * (renumbering agents' looks and the shared references by id) when it differs, then
   * the Directories' defaults on top, as the final word. The ONE step behind undo and
   * behind an edit's rollback.
   */
  function putBack(state: CharacterState): PutBack {
    if (!sameRoster(deps.profiles(), state.roster) && !deps.commitProfiles(state.roster)) {
      return 'roster-failed';
    }
    if (state.directories.length === 0) return 'done';
    const written = deps.writeDirectoryCharacters(state.directories);
    // Re-sent even when the write failed: part of it may have landed. (What the roster save
    // renumbered, it re-sent itself.)
    deps.characterRefsChanged();
    return written ? 'done' : 'directories-failed';
  }

  /** The newest edit, while the office still holds exactly what it wrote; else null. */
  function undoable(): CharacterEditEntry | null {
    const top = history[history.length - 1];
    if (!top || !sameRoster(deps.profiles(), top.roster.after)) return null;
    const now = defaultsByPath();
    for (const d of top.directories) {
      const current = now.get(d.path);
      if (!current || !sameList(current.characters, d.after)) return null;
    }
    return top;
  }

  function statusMessage(): AgentCharacterEditStatus {
    const top = undoable();
    return top
      ? {
          type: 'agentCharacterEditStatus',
          agentId: top.agentId,
          agentName: top.agentName,
          summary: top.summary,
        }
      : { type: 'agentCharacterEditStatus' };
  }

  /** Tell every office what an undo would revert, when that changed (always, with
   *  `landed`, as an edit lands: the Characters view names the agent then). */
  function announceStatus(landed = false): void {
    const message = statusMessage();
    const key = JSON.stringify(message);
    if (key === lastStatus && !landed) return;
    lastStatus = key;
    deps.broadcast(landed ? { ...message, landed: true } : { ...message });
  }

  return {
    edit(agentId, ops) {
      if (dirtyClients.size > 0) return { ok: false, reason: CHARACTERS_EDITING_REASON };
      const before = deps.profiles();
      const defaultsBefore = defaultsByPath();
      const result = applyCharacterOps(
        { profiles: before, renderer: deps.renderer(), directories: deps.directories() },
        ops,
      );
      if (!result.ok) return { ok: false, index: result.index, reason: result.reason };
      const { created, updated, deleted, notes, directoryWrites } = result;
      const directories = directoryWrites.map((w) => ({
        directory: w.name,
        characters: w.characters,
      }));
      if (!result.rosterChanged && directoryWrites.length === 0) {
        return { ok: true, changed: false, created, updated, deleted, directories, notes };
      }

      if (result.rosterChanged && !deps.commitProfiles(result.profiles)) {
        return {
          ok: false,
          reason: 'The characters could not be saved; try again.',
        };
      }
      const written =
        directoryWrites.length === 0 || deps.writeDirectoryCharacters(directoryWrites);
      if (!written) {
        if (!result.rosterChanged) {
          return {
            ok: false,
            reason: "The Directories' default characters could not be saved; try again.",
          };
        }
        // All or nothing: the roster landed, so put back the one it replaced (and the
        // Directories its save renumbered).
        const renumbered = defaultsChanges(defaultsBefore, defaultsByPath());
        const back = putBack({
          roster: before,
          directories: renumbered.map((d) => ({ path: d.path, characters: d.before })),
        });
        announceStatus();
        return back === 'done'
          ? {
              ok: false,
              reason:
                "The Directories' default characters could not be saved, so the characters were " +
                'put back as they were; try again.',
            }
          : {
              ok: false,
              partial: true,
              reason:
                "The Directories' default characters could not be saved, and the characters " +
                'could not be put back either: the roster may hold some of this batch and the ' +
                "Directories' defaults may have moved. Check list_characters before trying again.",
            };
      }
      // What the roster save renumbered it re-sent itself; the batch's own writes, here.
      if (directoryWrites.length > 0) deps.characterRefsChanged();

      const after = result.rosterChanged ? deps.profiles() : before;
      history.push({
        agentId,
        agentName: deps.agentName(agentId),
        summary: editSummary(result, before, after),
        roster: { before, after },
        directories: defaultsChanges(defaultsBefore, defaultsByPath()),
      });
      if (history.length > CHARACTER_UNDO_DEPTH) history.shift();
      announceStatus(true);
      return { ok: true, changed: true, created, updated, deleted, directories, notes };
    },

    undo() {
      if (dirtyClients.size > 0) return { ok: false, reason: CHARACTERS_EDITING_REASON };
      const top = history[history.length - 1];
      if (!top) return { ok: false, reason: 'There is no agent Character edit to undo.' };
      if (!undoable()) {
        return {
          ok: false,
          reason:
            'The characters or the Directories it touched changed since the last agent Character ' +
            'edit (someone saved over it), so undo would discard newer work; nothing was undone.',
        };
      }
      const back = putBack({
        roster: top.roster.before,
        directories: top.directories.map((d) => ({ path: d.path, characters: d.before })),
      });
      if (back !== 'done') {
        // Half put back: the edit's own state again, so nothing was undone.
        const redone =
          back === 'roster-failed' ||
          putBack({
            roster: top.roster.after,
            directories: top.directories.map((d) => ({ path: d.path, characters: d.after })),
          }) === 'done';
        announceStatus();
        return {
          ok: false,
          reason: redone
            ? 'The characters could not be saved; nothing was undone. Try again.'
            : "The characters were put back but the Directories' default characters could not " +
              'be, and the edit could not be restored either. Check list_characters.',
        };
      }
      history.pop();
      announceStatus();
      const ids = (list: CharacterProfile[]) =>
        new Map(list.map((p, i) => [characterIdOf(p, i), p]));
      const was = ids(top.roster.before);
      const wrote = ids(top.roster.after);
      return {
        ok: true,
        agentId: top.agentId,
        agentName: top.agentName,
        summary: top.summary,
        restored: [...was]
          .filter(([id, p]) => !wrote.has(id) || !sameRoster([p], [wrote.get(id)!]))
          .map(([id]) => id),
        removed: [...wrote]
          .filter(([id]) => !was.has(id))
          .map(([id, p]) => ({ id, name: p.name ?? '' })),
        directories: top.directories.map((d) => ({ directory: d.name, characters: d.before })),
      };
    },

    setEditing(client, dirty) {
      if (dirty) dirtyClients.add(client);
      else dirtyClients.delete(client);
    },

    clientGone(client) {
      dirtyClients.delete(client);
    },

    statusMessage,

    charactersChanged() {
      announceStatus();
    },

    history: () => history,
  };
}

/** What an edit did, in a few words, as the office says it: "created Naruto, changed
 *  Bob, deleted Dress, changed Varys's defaults". Names as the roster has them after it. */
function editSummary(
  result: {
    created: EditedCharacter[];
    updated: EditedCharacter[];
    deleted: EditedCharacter[];
    directoryWrites: Array<{ name: string }>;
  },
  before: CharacterProfile[],
  after: CharacterProfile[],
): string {
  const nameIn = (list: CharacterProfile[], id: string) => {
    const index = list.findIndex((p, i) => characterIdOf(p, i) === id);
    return (index >= 0 && list[index].name) || id;
  };
  const once = (list: EditedCharacter[], skip: Set<string>) => [
    ...new Set(list.map((c) => c.id).filter((id) => !skip.has(id))),
  ];
  const deleted = once(result.deleted, new Set());
  const created = once(result.created, new Set(deleted));
  const updated = once(result.updated, new Set([...created, ...deleted]));
  const listed = (names: string[]) => {
    const shown = names.slice(0, CHARACTER_SUMMARY_NAMES);
    const more = names.length - shown.length;
    return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  };
  const named = (verb: string, names: string[]) =>
    names.length ? [`${verb} ${listed(names)}`] : [];
  const directoriesPart = (names: string[]) =>
    names.length === 0
      ? []
      : names.length === 1
        ? [`changed ${names[0]}'s defaults`]
        : [`changed the defaults of ${listed(names)}`];
  return [
    ...named(
      'created',
      created.map((id) => nameIn(after, id)),
    ),
    ...named(
      'changed',
      updated.map((id) => nameIn(after, id)),
    ),
    ...named(
      'deleted',
      deleted.map((id) => nameIn(before, id)),
    ),
    ...directoriesPart([...new Set(result.directoryWrites.map((d) => d.name))]),
  ].join(', ');
}

/** Two rosters hold the same characters, field for field (key order aside). */
function sameRoster(a: readonly CharacterProfile[], b: readonly CharacterProfile[]): boolean {
  return a === b || canonicalJson(a) === canonicalJson(b);
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
