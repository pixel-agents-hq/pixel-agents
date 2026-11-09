import { describe, expect, it } from 'vitest';

import { type CharacterProfile, MAX_CHARACTER_PROFILES } from '../../core/src/characterProfiles.js';
import { CastStore } from '../src/characters/cast.js';

const named = (...names: string[]): CharacterProfile[] =>
  names.map((name) => ({ name, body: 'flat', v: 33 }));
/** A copy as the server would send it (same JSON, new objects). */
const wire = (profiles: readonly CharacterProfile[]) =>
  JSON.parse(JSON.stringify(profiles)) as CharacterProfile[];

function setup() {
  const saves: { profiles: CharacterProfile[]; saveId: string }[] = [];
  let t = 0;
  const store = new CastStore({
    save: (profiles, saveId) => saves.push({ profiles, saveId }),
    now: () => (t += 1000), // every change its own undo step
  });
  store.receiveProfiles(named('A', 'B'));
  const rename = (name: string) =>
    store.update((p) => {
      p.name = name;
    });
  /** The saved list (what the office wears). */
  const names = () => store.getState().profiles.map((p) => p.name);
  /** The view's list: the draft, else the saved one. */
  const drafted = () => (store.getState().draft ?? store.getState().profiles).map((p) => p.name);
  return { store, saves, rename, names, drafted };
}

describe('CastStore drafts', () => {
  it('edits stay in the draft until saved; the saved list is untouched', () => {
    const { store, saves, rename, names, drafted } = setup();
    rename('A1');
    expect(drafted()).toEqual(['A1', 'B']);
    expect(names()).toEqual(['A', 'B']);
    expect(store.getState().dirty).toBe(true);
    expect(saves).toHaveLength(0);
    store.save();
    expect(names()).toEqual(['A1', 'B']);
    expect(store.getState().dirty).toBe(false);
    expect(saves).toHaveLength(1);
    expect(saves[0].profiles.map((p) => p.name)).toEqual(['A1', 'B']);
  });

  it('a new character exists only in the draft until saved; discard drops it', () => {
    const { store, saves, names, drafted } = setup();
    expect(store.add(named('New'))).toBe(1);
    expect(store.getState().current).toBe(2);
    expect(drafted()).toEqual(['A', 'B', 'New']);
    expect(names()).toEqual(['A', 'B']);
    store.discard();
    expect(store.getState().draft).toBeNull();
    expect(store.getState().current).toBe(1);
    expect(names()).toEqual(['A', 'B']);
    expect(saves).toHaveLength(0);
  });

  it('undoing back to where the draft started is clean again; selecting is not a change', () => {
    const { store, rename } = setup();
    store.select(1);
    expect(store.getState().dirty).toBe(false);
    rename('B1');
    expect(store.getState().dirty).toBe(true);
    store.undo();
    expect(store.getState().dirty).toBe(false);
  });

  it('save with nothing changed sends nothing', () => {
    const { store, saves } = setup();
    store.select(0);
    store.save();
    expect(saves).toHaveLength(0);
  });
});

describe('CastStore sync with the server', () => {
  it('its own echo changes nothing; another client’s list replaces a clean draft', () => {
    const { store, saves, rename, names, drafted } = setup();
    rename('A1');
    store.save();
    const before = store.getState();
    store.receiveProfiles(wire(saves[0].profiles), saves[0].saveId);
    expect(store.getState()).toBe(before);
    expect(store.getState().canUndo).toBe(true);
    store.receiveProfiles(named('X'), 'theirs');
    expect(names()).toEqual(['X']);
    expect(drafted()).toEqual(['X']);
    expect(store.getState().canUndo).toBe(false);
  });

  it('a dirty draft survives another client’s list (saving it then wins)', () => {
    const { store, saves, rename, names, drafted } = setup();
    rename('A1');
    store.receiveProfiles(named('X'));
    expect(names()).toEqual(['X']);
    expect(drafted()).toEqual(['A1', 'B']);
    expect(store.getState().dirty).toBe(true);
    store.save();
    expect(saves[0].profiles.map((p) => p.name)).toEqual(['A1', 'B']);
  });

  it('ignores foreign lists while a save is in flight; an answer acks every older save', () => {
    const { store, saves, rename, names } = setup();
    rename('A1');
    store.save();
    rename('A2');
    store.save();
    expect(saves).toHaveLength(2);
    store.receiveProfiles(named('Y'), 'theirs'); // processed before our saves
    expect(names()).toEqual(['A2', 'B']);
    store.receiveProfiles(named('stale'), saves[0].saveId);
    expect(names()).toEqual(['A2', 'B']);
    store.receiveProfiles(wire(saves[1].profiles), saves[1].saveId);
    store.receiveProfiles(named('Z'));
    expect(names()).toEqual(['Z']);
  });

  it('a refused save is answered with the list on disk: adopted, history cleared', () => {
    const { store, saves, rename, names, drafted } = setup();
    rename('A1');
    store.save();
    store.receiveProfiles(named('A', 'B'), saves[0].saveId);
    expect(names()).toEqual(['A', 'B']);
    expect(drafted()).toEqual(['A', 'B']);
    expect(store.getState().canUndo).toBe(false);
  });

  it('an unreadable answer still acks its save', () => {
    const { store, saves, rename, names } = setup();
    rename('A1');
    store.save();
    store.receiveProfiles(null, saves[0].saveId);
    store.receiveProfiles(named('Z'));
    expect(names()).toEqual(['Z']);
  });

  it('resendInFlight re-sends the saved list after a reconnect', () => {
    const { store, saves, rename } = setup();
    store.resendInFlight();
    expect(saves).toHaveLength(0);
    rename('A1');
    store.save();
    store.resendInFlight();
    expect(saves).toHaveLength(2);
    expect(saves[1].profiles).toEqual(saves[0].profiles);
    store.receiveProfiles(wire(saves[1].profiles), saves[1].saveId);
    store.resendInFlight();
    expect(saves).toHaveLength(2);
  });
});

describe('CastStore edits', () => {
  it('add stops at MAX_CHARACTER_PROFILES and says how many fit', () => {
    const { store, drafted } = setup();
    const many = Array.from({ length: MAX_CHARACTER_PROFILES }, (_, i) => named(`N${i}`)[0]);
    expect(store.add(many)).toBe(MAX_CHARACTER_PROFILES - 2);
    expect(drafted()).toHaveLength(MAX_CHARACTER_PROFILES);
    expect(store.add(named('one more'))).toBe(0);
  });

  it('an added character gets an id of its own, even a copy of another', () => {
    const { store } = setup();
    const original = { ...named('A')[0], id: 'a' };
    store.add([original, original], 1);
    const [x, y] = store
      .getState()
      .draft!.slice(1, 3)
      .map((p) => p.id);
    expect(x).toBeTruthy();
    expect(y).toBeTruthy();
    expect(x).not.toBe(y);
    expect([x, y]).not.toContain('a');
  });

  it('undo restores the profiles and returns the frame; card switches are no step', () => {
    const { store, drafted } = setup();
    store.update((p) => {
      p.name = 'A1';
    }, 4);
    store.select(1);
    expect(store.undo()).toBe(4);
    expect(drafted()).toEqual(['A', 'B']);
    expect(store.getState().current).toBe(0);
    expect(store.redo()).toBe(4);
    expect(drafted()).toEqual(['A1', 'B']);
  });
});

describe('CastStore wardrobe items', () => {
  const item = { id: 'custom_x', piece: 'hair', label: 'Mine', base: 'bob', png: 'AA==' };

  function itemSetup() {
    const saves: { profiles: CharacterProfile[]; items: unknown[] }[] = [];
    let t = 0;
    const store = new CastStore({
      save: (profiles, _saveId, items) => saves.push({ profiles, items }),
      now: () => (t += 1000),
    });
    store.receiveProfiles(
      [
        { name: 'A', body: 'flat', hair: 'bob', v: 33 },
        { name: 'B', body: 'flat', v: 33 },
      ],
      undefined,
      [],
    );
    return { store, saves };
  }

  it('a new item is drafted with the change that wears it, and saved with the profiles', () => {
    const { store, saves } = itemSetup();
    expect(
      store.addItem(
        item,
        (p) => {
          p.hair = item.id;
        },
        10,
      ),
    ).toBe(true);
    const state = store.getState();
    expect(state.dirty).toBe(true);
    expect(state.items).toEqual([]);
    expect(state.draftItems).toEqual([item]);
    expect(state.draft?.[0].hair).toBe(item.id);
    store.save();
    expect(saves).toEqual([
      { profiles: [expect.objectContaining({ hair: item.id }), expect.anything()], items: [item] },
    ]);
    expect(store.getState().items).toEqual([item]);
  });

  it('undo takes the item and its wearing back in one step', () => {
    const { store } = itemSetup();
    store.addItem(item, (p) => void (p.hair = item.id), 10);
    store.undo();
    expect(store.getState().draftItems).toEqual([]);
    expect(store.getState().draft?.[0].hair).toBe('bob');
    expect(store.getState().dirty).toBe(false);
  });

  it('refuses an item past the limit', () => {
    const { store } = itemSetup();
    expect(store.addItem(item, () => {}, 0)).toBe(false);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().draftItems).toEqual([]);
  });

  it('deleting an item takes it off every character, with its edits', () => {
    const { store } = itemSetup();
    store.receiveProfiles(
      [
        {
          name: 'A',
          body: 'flat',
          hair: item.id,
          edits: { [`hair:${item.id}`]: { cells: {} } },
          v: 33,
        },
        { name: 'B', body: 'flat', hair: item.id, v: 33 },
      ],
      undefined,
      [item],
    );
    store.removeItem(item.id);
    const { draft, draftItems } = store.getState();
    expect(draftItems).toEqual([]);
    expect(draft?.map((p) => p.hair)).toEqual([undefined, undefined]);
    expect(draft?.[0].edits).toEqual({});
  });

  it('a foreign list with new items replaces a clean draft, items too', () => {
    const { store } = itemSetup();
    store.select(1);
    store.receiveProfiles([{ name: 'Z', body: 'flat', v: 33 }], undefined, [item]);
    expect(store.getState().draftItems).toEqual([item]);
    expect(store.getState().dirty).toBe(false);
  });
});
