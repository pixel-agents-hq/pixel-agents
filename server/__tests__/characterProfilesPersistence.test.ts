import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  getCharacterProfiles,
  getWardrobeItems,
  handleCharacterProfilesClientMessage,
  watchCharacterProfiles,
} from '../src/characterProfilesPersistence.js';
import { getPaletteCount } from '../src/paletteAssigner.js';

/**
 * The file side of the character-profile owner: the cache, and following characters.json
 * when another process (the other surface, another window, a hand edit) rewrites it.
 * Message semantics are pinned over the wire in clientMessageHandler.test.ts.
 */
describe('characterProfilesPersistence', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let watcher: { dispose(): void } | null = null;

  const profilesFile = () => path.join(tempHome, '.pixel-agents', 'characters.json');
  const writeExternally = (value: unknown) => {
    fs.mkdirSync(path.dirname(profilesFile()), { recursive: true });
    fs.writeFileSync(profilesFile(), JSON.stringify(value));
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-profiles-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    watcher?.dispose();
    watcher = null;
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('serves the defaults when nothing is saved, and a malformed file as the defaults', () => {
    expect(getCharacterProfiles()).toEqual(DEFAULT_CHARACTER_PROFILES);
    // a new $HOME is a new file: re-read
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-profiles-bad-'));
    try {
      const file = path.join(process.env.HOME, '.pixel-agents', 'characters.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([{ body: 'flat', colors: { hair: 'red' } }]));
      expect(getCharacterProfiles()).toEqual(DEFAULT_CHARACTER_PROFILES);
    } finally {
      fs.rmSync(process.env.HOME, { recursive: true, force: true });
      process.env.HOME = tempHome;
    }
  });

  it('follows an external rewrite: cache, palette count and a saveId-less broadcast', async () => {
    writeExternally([{ id: 'one', name: 'One', body: 'flat', v: 35 }]);
    expect(getPaletteCount()).toBe(1);
    const broadcasts: Array<Record<string, unknown>> = [];
    watcher = watchCharacterProfiles((m) => broadcasts.push(m), new AgentStateStore());

    // mtime resolution: make sure the rewrite lands on a later timestamp
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = [
      { id: 'one', name: 'One', body: 'flat', v: 35 },
      { id: 'two', name: 'Two', body: 'bust', v: 35 },
    ];
    writeExternally(next);

    await vi.waitFor(() => expect(broadcasts).toHaveLength(1), { timeout: 5000 });
    expect(broadcasts[0]).toEqual({ type: 'characterProfilesLoaded', profiles: next, items: [] });
    expect(getCharacterProfiles()).toEqual(next);
    expect(getPaletteCount()).toBe(2);
  });

  it('ignores its own saves and an external rewrite that does not validate', async () => {
    writeExternally([{ id: 'one', name: 'One', body: 'flat', v: 35 }]);
    const watched: Array<Record<string, unknown>> = [];
    watcher = watchCharacterProfiles((m) => watched.push(m), new AgentStateStore());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const answers: Array<Record<string, unknown>> = [];
    const own = [{ id: 'mine', name: 'Mine', body: 'bust', v: 35 }];
    handleCharacterProfilesClientMessage(
      { profiles: own, saveId: 'own' },
      {
        broadcast: (m) => answers.push(m),
        reply: (m) => answers.push(m),
        store: new AgentStateStore(),
        sharedRefsChanged: () => {},
      },
    );
    expect(answers).toEqual([
      { type: 'characterProfilesLoaded', profiles: own, items: [], saveId: 'own' },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeExternally([{ body: 'flat', edits: { 'top:x': { rev: 1, cells: { '0': null } } } }]);

    // a full poll interval (2 s) and then some: neither change is reported
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(watched).toEqual([]);
    expect(getCharacterProfiles()).toEqual(own);
  });
  describe('wardrobe items', () => {
    const itemsFile = () => path.join(tempHome, '.pixel-agents', 'wardrobe-items.json');
    const item = {
      id: 'custom_abc123',
      piece: 'hair',
      label: 'My bob',
      base: 'bob',
      png: 'iVBORw0KGgo=',
    };
    const profiles = [{ id: 'one', name: 'One', body: 'flat', hair: 'custom_abc123', v: 35 }];
    const save = (msg: Record<string, unknown>) => {
      const answers: Array<Record<string, unknown>> = [];
      handleCharacterProfilesClientMessage(msg, {
        broadcast: (m) => answers.push({ ...m, to: 'all' }),
        reply: (m) => answers.push({ ...m, to: 'sender' }),
        store: new AgentStateStore(),
        sharedRefsChanged: () => {},
      });
      return answers;
    };

    it('a save with items persists them beside the profiles and broadcasts both', () => {
      expect(save({ profiles, items: [item], saveId: 's' })).toEqual([
        { type: 'characterProfilesLoaded', profiles, items: [item], saveId: 's', to: 'all' },
      ]);
      expect(JSON.parse(fs.readFileSync(itemsFile(), 'utf-8'))).toEqual([item]);
      expect(getWardrobeItems()).toEqual([item]);
    });

    it('a save without items keeps the saved ones', () => {
      save({ profiles, items: [item], saveId: 'a' });
      const answers = save({ profiles, saveId: 'b' });
      expect(answers[0]).toMatchObject({ items: [item], to: 'all' });
    });

    it('invalid items refuse the whole save', () => {
      const answers = save({
        profiles,
        items: [{ ...item, id: 'bob' }],
        saveId: 'bad',
      });
      expect(answers).toEqual([
        {
          type: 'characterProfilesLoaded',
          profiles: DEFAULT_CHARACTER_PROFILES,
          items: [],
          saveId: 'bad',
          to: 'sender',
        },
      ]);
      expect(fs.existsSync(itemsFile())).toBe(false);
      expect(fs.existsSync(profilesFile())).toBe(false);
    });

    it('follows an external rewrite of the items file', async () => {
      const watched: Array<Record<string, unknown>> = [];
      watcher = watchCharacterProfiles((m) => watched.push(m), new AgentStateStore());
      await new Promise((resolve) => setTimeout(resolve, 20));
      fs.mkdirSync(path.dirname(itemsFile()), { recursive: true });
      fs.writeFileSync(itemsFile(), JSON.stringify([item]));
      await vi.waitFor(() => expect(watched).toHaveLength(1), { timeout: 5000 });
      expect(watched[0]).toMatchObject({ type: 'characterProfilesLoaded', items: [item] });
      expect(getWardrobeItems()).toEqual([item]);
    });
  });
});
