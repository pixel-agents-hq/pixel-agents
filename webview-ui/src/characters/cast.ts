/**
 * The cast: the character profiles agents are drawn from, as one store shared by the office
 * (which wears them, see officeSprites.ts) and the Characters view (which edits them).
 * DOM- and transport-free: castStore.ts wires the app's instance to the server.
 *
 * Editing works on a draft: the Characters view changes a working copy of the list, and
 * the office (and every other reader of `profiles`) keeps the saved one until the view
 * saves. A draft opens on the first change, select or add; it is dirty once it differs
 * from the list it started from (or was last saved as); save() sends it, discard() drops it.
 *
 * Sync with the server: a save sends the whole list under a fresh saveId, and the server
 * answers each save with characterProfilesLoaded carrying it, in order. An answer acks its save and every older one. While a save is in flight or pending,
 * other lists are stale (processed before ours, or about to be overwritten by it: last
 * writer wins) and are ignored; otherwise the server's list wins, and replaces ours (and the
 * undo history that led to it) when it differs. A refused save is answered with the list on
 * disk, so the view shows the truth.
 *
 * The custom wardrobe items (parts saved from the pixel editor) travel with the profiles:
 * they open with the draft, step with its undo history, and are sent with it on Save.
 */

import type { CharacterProfile } from '../../../core/src/characterProfiles.js';
import {
  MAX_CHARACTER_PROFILES,
  newCharacterId,
  pixId,
} from '../../../core/src/characterProfiles.js';
import { newLocalId } from '../../../core/src/localId.js';
import { MAX_WARDROBE_ITEMS, type WardrobeItem } from '../../../core/src/wardrobeItems.js';
import { CAST_HISTORY } from '../constants.js';
import { History } from './history.js';
import type { CharacterRenderer } from './renderer.js';

/** The cast as one value: the profiles and the items they may wear move together. */
interface Cast {
  profiles: readonly CharacterProfile[];
  items: readonly WardrobeItem[];
}

interface Snapshot extends Cast {
  current: number;
}

export interface CastState {
  /** The saved list: what the office wears. */
  profiles: readonly CharacterProfile[];
  /** The Characters view's working copy, while one is open. */
  draft: readonly CharacterProfile[] | null;
  /** The saved custom wardrobe items. */
  items: readonly WardrobeItem[];
  /** The draft's items, while a draft is open. */
  draftItems: readonly WardrobeItem[] | null;
  /** The draft has changes the saved list doesn't. */
  dirty: boolean;
  /** The character being edited (an index into the draft, or the list when none). */
  current: number;
  /** Null until the wardrobe art is decoded. */
  renderer: CharacterRenderer | null;
  /** The characters launched most recently, most recent first (profile
   *  indices): the server's, shared by every office (recentCharactersLoaded). */
  recent: readonly number[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface CastDeps {
  /** Send the list (and the items) to the server under `saveId`. */
  save: (profiles: CharacterProfile[], saveId: string, items: WardrobeItem[]) => void;
  /** Milliseconds, for grouping undo steps. */
  now?: () => number;
}

/** A save's id. */
const newSaveId = () => newLocalId('', undefined, '-');

const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** What `set` may change: the casts, and the state's other fields (the derived ones aside). */
type Patch = Partial<
  Omit<CastState, 'profiles' | 'items' | 'draft' | 'draftItems' | 'dirty' | 'canUndo' | 'canRedo'>
> & {
  saved?: Cast;
  draft?: Cast | null;
};

export class CastStore {
  /** The saved cast: what the office wears. */
  private saved: Cast = { profiles: [], items: [] };
  /** The view's working copy, while one is open. */
  private draft: Cast | null = null;
  /** What the open draft started from (or was last saved as): undoing back to it is clean. */
  private base: Cast | null = null;
  private state: CastState = {
    profiles: [],
    draft: null,
    items: [],
    draftItems: null,
    dirty: false,
    current: 0,
    renderer: null,
    recent: [],
    canUndo: false,
    canRedo: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly history = new History<Snapshot>(CAST_HISTORY);
  /** Saves sent and not yet answered, oldest first. */
  private inFlight: string[] = [];
  private readonly deps: CastDeps;

  constructor(deps: CastDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  /** The casts projected onto the state's fields (`profiles`/`items`, `draft`/`draftItems`). */
  private project(): Pick<CastState, 'profiles' | 'items' | 'draft' | 'draftItems'> {
    return {
      profiles: this.saved.profiles,
      items: this.saved.items,
      draft: this.draft?.profiles ?? null,
      draftItems: this.draft?.items ?? null,
    };
  }

  private set({ saved, draft, ...view }: Patch): void {
    if (saved) this.saved = saved;
    if (draft !== undefined) this.draft = draft;
    const { base } = this;
    this.state = {
      ...this.state,
      ...view,
      ...this.project(),
      dirty:
        !!this.draft &&
        (this.draft.profiles !== base?.profiles || this.draft.items !== base?.items),
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    };
    for (const listener of this.listeners) listener();
  }

  setRenderer(renderer: CharacterRenderer): void {
    this.set({ renderer });
  }

  // ── From the server ──────────────────────────────────────

  /**
   * A characterProfilesLoaded: the saved list (null when it didn't validate), the saveId
   * it answers, if any, and the saved items (undefined: an older server, keep ours).
   */
  receiveProfiles(
    profiles: CharacterProfile[] | null,
    saveId?: string,
    items: readonly WardrobeItem[] = this.saved.items,
  ): void {
    const acked = saveId ? this.inFlight.indexOf(saveId) : -1;
    if (acked >= 0) this.inFlight.splice(0, acked + 1);
    if (!profiles || this.inFlight.length) return;
    // our own echo
    if (sameList(profiles, this.saved.profiles) && sameList(items, this.saved.items)) return;
    const saved = { profiles, items };
    if (this.draft && this.state.dirty) {
      // unsaved changes stay: saving them overwrites this list (last writer wins)
      this.set({ saved });
      return;
    }
    this.history.clear();
    if (this.draft) this.base = saved;
    this.set({
      saved,
      draft: this.draft ? saved : null,
      current: Math.min(this.state.current, Math.max(0, profiles.length - 1)),
    });
  }

  /** A recentCharactersLoaded. */
  receiveRecent(recent: readonly number[]): void {
    this.set({ recent });
  }

  /**
   * The connection came back: saves still in flight may never be answered, so send the
   * saved list again (the server's answers to the lost ones can't arrive any more).
   */
  resendInFlight(): void {
    if (!this.inFlight.length) return;
    this.inFlight = [];
    this.send();
  }

  // ── Edits ────────────────────────────────────────────────

  /** A press began (pointer down in the view): the next change starts an undo step. */
  beginStep(): void {
    this.history.beginStep();
  }

  /** The press ended. */
  endStep(): void {
    this.history.endStep();
  }

  /**
   * The cast being edited: the draft, opened from the saved cast when there is none. The
   * only place a draft opens. Opening one is silent (no listener is told): until it is
   * changed it shows exactly the saved cast, and the change that follows notifies.
   */
  private openDraft(): Cast {
    if (this.draft) return this.draft;
    this.draft = this.saved;
    this.base = this.saved;
    this.history.clear();
    this.state = { ...this.state, ...this.project() };
    return this.draft;
  }

  select(index: number): void {
    const { profiles } = this.openDraft();
    if (index < 0 || index >= profiles.length) return;
    this.set({ current: index });
  }

  /** Change the current profile through a draft copy. `frame`: the editor frame, for undo. */
  update(change: (draft: CharacterProfile) => void, frame: number | null = null): void {
    this.updateAt(this.state.current, change, frame);
  }

  updateAt(index: number, change: (draft: CharacterProfile) => void, frame: number | null = null) {
    this.edit(index, change, frame);
  }

  /**
   * Change profile `index` through a copy as one undo step, with the draft's items or
   * `items`. False when there is no such profile.
   */
  private edit(
    index: number,
    change: (draft: CharacterProfile) => void,
    frame: number | null,
    items?: readonly WardrobeItem[],
  ): boolean {
    const cast = this.openDraft();
    const profile = structuredClone(cast.profiles[index]);
    if (!profile) return false;
    change(profile);
    const profiles = [...cast.profiles];
    profiles[index] = profile;
    this.commit({ profiles, items: items ?? cast.items, current: this.state.current }, frame);
    return true;
  }

  /**
   * Add a custom item, and change the current profile in the same undo step (to wear it).
   * False when the wardrobe already holds `max` items (MAX_WARDROBE_ITEMS).
   */
  addItem(
    item: WardrobeItem,
    change: (draft: CharacterProfile) => void,
    max = MAX_WARDROBE_ITEMS,
  ): boolean {
    const { items } = this.openDraft();
    if (items.length >= max) return false;
    return this.edit(this.state.current, change, null, [...items, item]);
  }

  /** Delete a custom item: every character wearing it takes it off (and loses its edits on it). */
  removeItem(id: string): void {
    const cast = this.openDraft();
    const item = cast.items.find((i) => i.id === id);
    if (!item) return;
    const slot = item.piece as keyof CharacterProfile;
    const editKey = pixId(item.piece, id);
    const profiles = cast.profiles.map((p) => {
      if (p[slot] !== id && !p.edits?.[editKey]) return p;
      const copy = structuredClone(p);
      if (copy[slot] === id) delete copy[slot];
      if (copy.edits) delete copy.edits[editKey];
      return copy;
    });
    this.commit({
      profiles,
      items: cast.items.filter((i) => i !== item),
      current: this.state.current,
    });
  }

  /**
   * Insert profiles (at the end by default) and select the last one added. Each gets a new
   * id (a duplicate or a loaded config carries someone else's). The cast holds at most
   * MAX_CHARACTER_PROFILES: returns how many fit (the rest are dropped).
   */
  add(added: CharacterProfile[], at?: number): number {
    const cast = this.openDraft();
    at ??= cast.profiles.length;
    const fits = added
      .slice(0, Math.max(0, MAX_CHARACTER_PROFILES - cast.profiles.length))
      .map((p) => ({ ...p, id: newCharacterId() }));
    if (!fits.length) return 0;
    const profiles = [...cast.profiles];
    profiles.splice(at, 0, ...fits);
    this.commit({ profiles, items: cast.items, current: at + fits.length - 1 });
    return fits.length;
  }

  remove(index: number): void {
    const cast = this.openDraft();
    if (cast.profiles.length < 2) return;
    const profiles = cast.profiles.filter((_, i) => i !== index);
    this.commit({
      profiles,
      items: cast.items,
      current: Math.min(this.state.current, profiles.length - 1),
    });
  }

  private commit({ current, ...cast }: Snapshot, frame: number | null = null): void {
    this.history.record(this.snapshot(), frame, this.now());
    this.set({ draft: cast, current });
  }

  /** Step back; returns the editor frame the undone change was made on. */
  undo(): number | null {
    return this.restore(this.history.undo(this.snapshot()));
  }

  redo(): number | null {
    return this.restore(this.history.redo(this.snapshot()));
  }

  private snapshot(): Snapshot {
    return { ...this.openDraft(), current: this.state.current };
  }

  private restore(entry: { state: Snapshot; frame: number | null } | null): number | null {
    if (!entry) return null;
    const { profiles, items, current } = entry.state;
    this.set({
      draft: { profiles, items },
      current: Math.min(current, profiles.length - 1),
    });
    return entry.frame;
  }

  // ── Saving ───────────────────────────────────────────────

  /** Save the draft: it becomes the cast the office wears, and is sent to the server. */
  save(): void {
    const { draft } = this;
    if (!draft || !this.state.dirty) return;
    this.base = draft;
    this.set({ saved: draft });
    this.send();
  }

  /** Drop the draft and its history: the saved list stands. */
  discard(): void {
    if (!this.draft) return;
    this.base = null;
    this.history.clear();
    this.set({
      draft: null,
      current: Math.min(this.state.current, Math.max(0, this.saved.profiles.length - 1)),
    });
  }

  private send(): void {
    const saveId = newSaveId();
    this.inFlight.push(saveId);
    this.deps.save([...this.saved.profiles], saveId, [...this.saved.items]);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }
}
