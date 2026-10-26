import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { characterRemap, parseCharacterProfiles } from '../../core/src/characterProfiles.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  handleCharacterProfilesClientMessage,
  watchCharacterProfiles,
} from '../src/characterProfilesPersistence.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import { conversationLook, recordConversationLooks } from '../src/conversations.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';

/**
 * Everything that names a character by its index (agents, their saved seats, Directory
 * defaults, the roster's recency, past conversations' looks) stays on the same character
 * when a save inserts or deletes characters before it.
 */
const ch = (id: string) => ({ id, name: id, body: 'flat', v: 35 });

describe('characterRemap', () => {
  it('maps old indices to new ones by id, undefined for a deleted character', () => {
    const remap = characterRemap([ch('a'), ch('b'), ch('c')], [ch('a'), ch('x'), ch('c')])!;
    expect([0, 1, 2].map(remap)).toEqual([0, undefined, 2]);
  });

  it('moves the palettes past the profiles (external sprites) along with the count', () => {
    const remap = characterRemap([ch('a'), ch('b')], [ch('a'), ch('x'), ch('b')])!;
    expect([0, 1, 2, 3].map(remap)).toEqual([0, 2, 3, 4]);
  });

  it('is null when nothing moved (an edit, or a character added at the end)', () => {
    expect(characterRemap([ch('a'), ch('b')], [ch('a'), { ...ch('b'), hair: 'bob' }])).toBeNull();
    // added at the end: the old indices all stay, only the external palettes move
    expect(characterRemap([ch('a')], [ch('a'), ch('b')])).not.toBeNull();
  });

  it('reads a list saved before ids with the same index ids every time', () => {
    const legacy = [
      { body: 'flat', v: 35 },
      { body: 'bust', v: 35 },
    ];
    expect(parseCharacterProfiles(legacy)!.map((p) => p.id)).toEqual(['char-0', 'char-1']);
    expect(characterRemap(parseCharacterProfiles(legacy)!, parseCharacterProfiles(legacy)!)).toBe(
      null,
    );
  });

  it('a repeated id (a copy from before copies got their own) gets one of its own', () => {
    const list = [ch('a'), ch('b'), ch('a')];
    const ids = parseCharacterProfiles(list)!.map((p) => p.id);
    expect(ids).toEqual(['a', 'b', 'a-2']);
    expect(parseCharacterProfiles(list)!.map((p) => p.id)).toEqual(ids);
    // and never one another profile already has
    expect(
      parseCharacterProfiles([ch('a-1'), ch('a')].concat([ch('a')]))!.map((p) => p.id),
    ).toEqual(['a-1', 'a', 'a-2']);
  });

  it('is null between lists with no character in common (the defaults, then the real file)', () => {
    expect(characterRemap([ch('a'), ch('b')], [ch('x'), ch('y'), ch('z')])).toBeNull();
  });
});

describe('saving a list that moves characters', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;

  const agent = (id: number, palette: number, extra: Record<string, unknown> = {}) => {
    store.set(
      id,
      createAgentState({
        id,
        sessionId: `s${id}`,
        projectDir: tempHome,
        jsonlFile: path.join(tempHome, `s${id}.jsonl`),
        isExternal: false,
        palette,
        repeat: 0,
        ...extra,
      }),
    );
  };
  const save = (profiles: unknown[], sharedRefsChanged = () => {}) => {
    const answers: Array<Record<string, unknown>> = [];
    handleCharacterProfilesClientMessage(
      { profiles, saveId: 'x' },
      {
        broadcast: (m) => answers.push(m),
        reply: (m) => answers.push(m),
        store,
        sharedRefsChanged,
      },
    );
    return answers;
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-remap-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    save([ch('a'), ch('b'), ch('c')]);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('a character inserted before them keeps every reference on its character', () => {
    agent(1, 0);
    agent(2, 1);
    agent(3, 2);
    store.getAdapter()!.saveSeats({ '3': { palette: 2, repeat: 0, seatId: 'chair' } });
    recordConversationLooks(store, { '3': { seatId: 'chair' } });
    const cfg = readConfig();
    cfg.directories = [{ name: 'Work', path: tempHome, characters: [2, 1] }];
    cfg.recentCharacters = [2, 0, 1];
    writeConfig(cfg);

    const shared = vi.fn();
    const [answer] = save([ch('a'), ch('b2'), ch('b'), ch('c')], shared);

    expect(answer.agentLooks).toEqual([
      { id: 2, palette: 2, repeat: 0 },
      { id: 3, palette: 3, repeat: 0 },
    ]);
    expect(store.get(1)!.palette).toBe(0);
    expect(store.get(3)!.palette).toBe(3);
    expect(store.getAdapter()!.loadSeats()['3']).toMatchObject({ palette: 3, seatId: 'chair' });
    expect(store.loadPersistedAgents().find((p) => p.id === 3)?.palette).toBe(3);
    expect(conversationLook('s3')).toMatchObject({ palette: 3, seatId: 'chair' });
    expect(readConfig().directories[0].characters).toEqual([3, 2]);
    expect(readConfig().recentCharacters).toEqual([3, 0, 2]);
    expect(shared).toHaveBeenCalledOnce();
  });

  it('a deleted character: its wearers get another, its references go', () => {
    agent(1, 1);
    agent(2, 2);
    agent(5, 1, { leadAgentId: 1, teamName: 'team' });
    const cfg = readConfig();
    cfg.directories = [{ name: 'Work', path: tempHome, characters: [1, 2] }];
    cfg.recentCharacters = [1, 2];
    writeConfig(cfg);

    const [answer] = save([ch('a'), ch('c')]);

    expect(store.get(2)!.palette).toBe(1);
    const lead = store.get(1)!;
    expect(lead.palette).toBeGreaterThanOrEqual(0);
    expect(lead.palette).toBeLessThan(2);
    // a teammate follows its lead
    expect(store.get(5)!.palette).toBe(lead.palette);
    expect(answer.agentLooks).toHaveLength(3);
    expect(readConfig().directories[0].characters).toEqual([1]);
    expect(readConfig().recentCharacters).toEqual([1]);
  });

  it('a save that moves nothing sends no looks and leaves the shared files alone', () => {
    agent(1, 2);
    const shared = vi.fn();
    const [answer] = save([ch('a'), { ...ch('b'), hair: 'bob' }, ch('c')], shared);
    expect(answer).not.toHaveProperty('agentLooks');
    expect(shared).not.toHaveBeenCalled();
  });

  it("another process's rewrite renumbers this process's agents only", async () => {
    agent(1, 2);
    const cfg = readConfig();
    cfg.recentCharacters = [2];
    writeConfig(cfg);
    const broadcasts: Array<Record<string, unknown>> = [];
    const watcher = watchCharacterProfiles((m) => broadcasts.push(m), store);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'characters.json'),
        JSON.stringify([ch('x'), ch('a'), ch('b'), ch('c')]),
      );
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1), { timeout: 5000 });
      expect(broadcasts[0].agentLooks).toEqual([{ id: 1, palette: 3, repeat: 0 }]);
      // the process that saved renumbers the machine-wide files, not every watcher
      expect(readConfig().recentCharacters).toEqual([2]);
    } finally {
      watcher.dispose();
    }
  });
});
