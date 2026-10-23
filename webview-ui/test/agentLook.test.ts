/**
 * The agents' look (office/agentLook.ts): the Clawd / Classic setting, who
 * keeps the classic art (the NPCs), how a repo maps to a tint and an
 * accessory, what sub-agents and leads wear, the per-look geometry and the
 * blink clock. Pure, so it runs in the Node runner.
 *
 * Run with: npm test
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_LOOK_DEFAULT,
  AGENT_LOOK_STORAGE_KEY,
  ANSH_NPC_ID,
  CLAWD_BLINK_CLOSED_SEC,
  CLAWD_BLINK_PERIOD_SEC,
  CLAWD_TINTS,
  GREETER_ID,
  MANAGER_NPC_ID,
} from '../src/constants.js';
import type { LookSubject } from '../src/office/agentLook.js';
import {
  assignSlots,
  blinkClosed,
  CLAWD_ACCESSORIES,
  clawdIdentity,
  getAgentLook,
  getAgentLookVersion,
  identityKey,
  initAgentLook,
  isAgentLook,
  isNpcCharacter,
  loadAgentLook,
  lookMetrics,
  lookOf,
  metricsOf,
  noteLookSubjects,
  preferredSlot,
  resetLookSlots,
  saveAgentLook,
  setAgentLook,
  stableHash,
  subscribeAgentLook,
} from '../src/office/agentLook.js';

/** A localStorage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    map,
  };
}

const agent = (over: Partial<LookSubject> = {}): LookSubject => ({
  id: 1,
  palette: 0,
  hueShift: 0,
  isSubagent: false,
  ...over,
});

afterEach(() => {
  // Back to the default for the next test (nothing is persisted: null storage).
  setAgentLook(AGENT_LOOK_DEFAULT, null);
  resetLookSlots();
});

describe('the Agent Look setting', () => {
  it('defaults to Classic', () => {
    expect(AGENT_LOOK_DEFAULT).toBe('classic');
    expect(getAgentLook()).toBe('classic');
    expect(loadAgentLook(memoryStorage())).toBe('classic');
    expect(loadAgentLook(null)).toBe('classic');
  });

  it('reads a stored look and ignores garbage', () => {
    expect(loadAgentLook(memoryStorage({ [AGENT_LOOK_STORAGE_KEY]: 'clawd' }))).toBe('clawd');
    expect(loadAgentLook(memoryStorage({ [AGENT_LOOK_STORAGE_KEY]: 'chibi?' }))).toBe('classic');
    expect(isAgentLook('classic')).toBe(true);
    expect(isAgentLook('CLAWD')).toBe(false);
  });

  it('persists per browser, through the storage it is given', () => {
    const storage = memoryStorage();
    setAgentLook('clawd', storage);
    expect(storage.map.get(AGENT_LOOK_STORAGE_KEY)).toBe('clawd');
    expect(getAgentLook()).toBe('clawd');
    expect(initAgentLook(storage)).toBe('clawd');
  });

  it('survives a storage that throws (private mode, quota)', () => {
    const broken = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
    };
    expect(loadAgentLook(broken)).toBe('classic');
    expect(() => saveAgentLook('clawd', broken)).not.toThrow();
  });

  it('tells its subscribers once per change', () => {
    let calls = 0;
    const off = subscribeAgentLook(() => calls++);
    setAgentLook('clawd', null);
    setAgentLook('clawd', null); // no change, no call
    setAgentLook('classic', null);
    off();
    setAgentLook('clawd', null);
    expect(calls).toBe(2);
  });
});

describe('who is drawn how', () => {
  it('agents follow the setting; NPCs keep the classic art', () => {
    const npcs = [
      agent({ id: GREETER_ID, isGreeter: true }),
      agent({ id: ANSH_NPC_ID }),
      agent({ id: MANAGER_NPC_ID }),
      agent({ id: -42, isReceptionist: true }),
    ];
    for (const npc of npcs) {
      expect(isNpcCharacter(npc)).toBe(true);
      expect(lookOf(npc)).toBe('classic');
    }
    expect(isNpcCharacter(agent())).toBe(false);
    expect(lookOf(agent())).toBe('classic');

    setAgentLook('clawd', null);
    expect(lookOf(agent())).toBe('clawd');
    expect(lookOf(agent({ id: -1, isSubagent: true }))).toBe('clawd');
    for (const npc of npcs) expect(lookOf(npc)).toBe('classic');
  });
});

describe('a repo keeps its colour and accessory', () => {
  it('hashes stably', () => {
    expect(stableHash('hobbyfi-blog')).toBe(stableHash('hobbyfi-blog'));
    expect(stableHash('hobbyfi-blog')).not.toBe(stableHash('pixel-agents'));
    expect(stableHash('')).toBeGreaterThanOrEqual(0);
  });

  it('gives the same repo the same tint and accessory, whatever its session', () => {
    const a = clawdIdentity(agent({ id: 7, palette: 2, directoryName: 'hobbyfi-blog' }));
    const b = clawdIdentity(
      agent({ id: 99, palette: 5, hueShift: 120, directoryName: 'hobbyfi-blog' }),
    );
    expect(a).toEqual(b);
    expect(a.tint).toBeGreaterThanOrEqual(0);
    expect(a.tint).toBeLessThan(CLAWD_TINTS.length);
    expect(a.accessory).not.toBeNull();
    expect(CLAWD_ACCESSORIES).toContain(a.accessory);
  });

  it('spreads different repos over the tints and accessories', () => {
    const repos = [
      'hobbyfi-blog',
      'pixel-agents',
      'remote',
      'dotfiles',
      'api',
      'www',
      'infra',
      'app',
    ];
    const ids = repos.map((directoryName) => clawdIdentity(agent({ directoryName })));
    expect(new Set(ids.map((i) => i.tint)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(ids.map((i) => i.accessory)).size).toBeGreaterThanOrEqual(3);
  });

  it('falls back to the office palette without a repo', () => {
    const a = clawdIdentity(agent({ palette: 3 }));
    expect(a.tint).toBe(3 % CLAWD_TINTS.length);
    expect(a.accessory).toBe(CLAWD_ACCESSORIES[3 % CLAWD_ACCESSORIES.length]);
    expect(clawdIdentity(agent({ palette: 0 })).tint).not.toBe(
      clawdIdentity(agent({ palette: 1 })).tint,
    );
  });

  it('sub-agents wear the parent tint and nothing else; leads wear the crown', () => {
    const parent = agent({ id: 4, directoryName: 'hobbyfi-blog' });
    const sub = clawdIdentity(agent({ id: -1, isSubagent: true, palette: 5 }), parent);
    expect(sub.tint).toBe(clawdIdentity(parent).tint);
    expect(sub.accessory).toBeNull();
    // An orphan helper (parent gone) still has a plain look of its own.
    expect(clawdIdentity(agent({ id: -2, isSubagent: true, palette: 1 })).accessory).toBeNull();
    const lead = clawdIdentity(agent({ directoryName: 'hobbyfi-blog', isTeamLead: true }));
    expect(lead.tint).toBe(clawdIdentity(parent).tint);
    expect(lead.accessory).toBeNull();
  });
});

describe('the geometry per look', () => {
  it('hangs everything lower off a Clawd than off a chibi', () => {
    const chibi = lookMetrics('classic');
    const clawd = lookMetrics('clawd');
    for (const key of [
      'headRise',
      'handRise',
      'mouthRise',
      'labelRise',
      'bubbleRise',
      'bubbleSitDrop',
      'hitHeight',
      'confettiRise',
    ] as const) {
      expect(clawd[key]).toBeLessThan(chibi[key]);
    }
    // The label still clears the head (and the tallest accessory, 4 px).
    expect(clawd.labelRise).toBeGreaterThanOrEqual(clawd.headRise + 4);
    // The mug shot crops the lower half of the frame, where the Clawd lives.
    expect(clawd.mugshotCropTop).toBeGreaterThan(chibi.mugshotCropTop);
  });

  it('is the classic geometry for NPCs even under the Clawd look', () => {
    setAgentLook('clawd', null);
    expect(metricsOf(agent({ id: ANSH_NPC_ID }))).toBe(lookMetrics('classic'));
    expect(metricsOf(agent())).toBe(lookMetrics('clawd'));
  });
});

describe('blinking', () => {
  it('shuts the eyes once per period, briefly, offset per agent', () => {
    const closedFor = (seed: number) => {
      let closed = 0;
      const step = 0.01;
      for (let t = 0; t < CLAWD_BLINK_PERIOD_SEC; t += step) if (blinkClosed(t, seed)) closed++;
      return closed * step;
    };
    expect(closedFor(1)).toBeCloseTo(CLAWD_BLINK_CLOSED_SEC, 1);
    expect(closedFor(2)).toBeCloseTo(CLAWD_BLINK_CLOSED_SEC, 1);
    // Different agents don't all blink at once.
    const firstClosed = (seed: number) => {
      for (let t = 0; t < CLAWD_BLINK_PERIOD_SEC; t += 0.01) if (blinkClosed(t, seed)) return t;
      return -1;
    };
    const starts = new Set([1, 2, 3, 4, 5].map((s) => Math.round(firstClosed(s) * 10)));
    expect(starts.size).toBeGreaterThan(1);
  });
});

describe('repos on the board can be told apart', () => {
  it('hands the agents present distinct tints and accessories', () => {
    // Eight repos: more than a pure hash keeps apart (it gave three violets).
    const repos = [
      'hobbyfi-blog',
      'pixel-agents',
      'dotfiles',
      'api-server',
      'website',
      'remote-relay',
      'team-app',
    ];
    const agents = repos.map((directoryName, i) => agent({ id: i + 1, directoryName }));
    noteLookSubjects(agents);
    const ids = agents.map((a) => clawdIdentity(a));
    expect(new Set(ids.map((i) => i.tint)).size).toBe(Math.min(repos.length, CLAWD_TINTS.length));
    expect(new Set(ids.map((i) => i.accessory)).size).toBe(
      Math.min(repos.length, CLAWD_ACCESSORIES.length),
    );
  });

  it('keeps a repo its look as others come and go', () => {
    const a = agent({ id: 1, directoryName: 'hobbyfi-blog' });
    const b = agent({ id: 2, directoryName: 'pixel-agents' });
    noteLookSubjects([a]);
    const before = clawdIdentity(a);
    expect(before.tint).toBe(preferredSlot(identityKey(a), CLAWD_TINTS.length, ''));
    noteLookSubjects([a, b]);
    expect(clawdIdentity(a)).toEqual(before);
    noteLookSubjects([b]);
    noteLookSubjects([a, b]);
    expect(clawdIdentity(a)).toEqual(before);
    // Another session of the same repo is the same Clawd.
    expect(clawdIdentity(agent({ id: 9, directoryName: 'hobbyfi-blog' }))).toEqual(before);
  });

  it('ignores helpers and NPCs, and tells the mug shots when something changed', () => {
    const v0 = getAgentLookVersion();
    noteLookSubjects([agent({ id: ANSH_NPC_ID }), agent({ id: -1, isSubagent: true })]);
    expect(getAgentLookVersion()).toBe(v0);
    noteLookSubjects([agent({ id: 1, directoryName: 'hobbyfi-blog' })]);
    expect(getAgentLookVersion()).toBeGreaterThan(v0);
    const v1 = getAgentLookVersion();
    noteLookSubjects([agent({ id: 1, directoryName: 'hobbyfi-blog' })]);
    expect(getAgentLookVersion()).toBe(v1); // nothing new: no redraw
  });

  it('assigns slots: preferred when free, next free otherwise, shared when all are taken', () => {
    const sticky = new Map<string, number>();
    const want = (k: string) => preferredSlot(k, 3, '');
    const keys = ['palette:0', 'palette:3', 'palette:1', 'palette:2'];
    // palette:0 and palette:3 both want slot 0 of 3.
    expect(want('palette:0')).toBe(0);
    expect(want('palette:3')).toBe(0);
    expect(assignSlots(keys.slice(0, 3), sticky, 3, '')).toBe(true);
    expect(sticky.get('palette:0')).toBe(0);
    expect(sticky.get('palette:3')).toBe(1); // probed to the next free slot
    expect(sticky.get('palette:1')).toBe(2); // its own (1) was taken
    expect(assignSlots(keys.slice(0, 3), sticky, 3, '')).toBe(false);
    assignSlots(keys, sticky, 3, '');
    expect(sticky.get('palette:2')).toBe(2); // all taken: its preferred one
  });

  it('gives agents without a repo their palette slot', () => {
    expect(identityKey({ palette: 4 })).toBe('palette:4');
    expect(identityKey({ palette: 4, directoryName: 'x' })).toBe('repo:x');
    expect(preferredSlot('palette:4', CLAWD_TINTS.length, '')).toBe(4 % CLAWD_TINTS.length);
  });

  it('lifts a lead Clawd label clear of its crown, and leaves chibis as they were', () => {
    expect(lookMetrics('clawd').leadLift).toBeGreaterThan(0);
    expect(lookMetrics('classic').leadLift).toBe(0);
  });
});
