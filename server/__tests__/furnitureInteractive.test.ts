/**
 * The furniture contract: a manifest's `interactive` block, validated once where
 * manifests are read (one validator for the server and the office), and the ONE
 * pure rules function that says, for a piece and the office's facts about it,
 * which state it shows, what its label says and what a click on it resolves to.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.js';
import {
  type FurnitureInteractive,
  parseInteractive,
  withInteractive,
} from '../../core/src/furniture/interactive.js';
import { type PieceFacts, pieceView } from '../../core/src/furniture/pieceRules.js';
import {
  catalogEntry,
  createFurnitureCatalog,
  stateVariantOf,
} from '../../core/src/layout/index.js';
import { loadFurnitureAssets } from '../src/assetLoader.js';
import { loadAllFurniture } from '../src/assetReload.js';
import { removeTempDir } from './helpers/removeTempDir.js';

const ASSETS_ROOT = path.resolve(__dirname, '../../webview-ui/public');
const ON_OFF = new Set(['on', 'off']);

const FREE: PieceFacts = {
  agentAtWork: null,
  agentSeated: null,
  panelInUse: null,
  places: [],
  readOnly: false,
};
const AGENT: PieceFacts = {
  ...FREE,
  agentAtWork: { id: 7, name: 'Ada' },
  agentSeated: { id: 7, name: 'Ada' },
};
/** Ada's desk, Ada idle between turns. */
const SEATED: PieceFacts = { ...FREE, agentSeated: { id: 7, name: 'Ada' } };
const SHELL: PieceFacts = { ...FREE, panelInUse: { name: 'pixel-agents' } };
const BOTH: PieceFacts = { ...AGENT, panelInUse: { name: 'pixel-agents' } };

const PC_LIKE: FurnitureInteractive = {
  agentUse: 'workstation',
  label: {
    name: 'PC',
    lines: [
      { when: ['panelInUse'], text: 'Shell in {panel}' },
      { when: ['agentSeated'], text: '{agent} works here' },
      { when: ['free'], text: 'Free' },
    ],
  },
  panel: 'terminal',
  states: [{ state: 'on', when: ['agentWorking', 'panelInUse'] }],
};

describe('parseInteractive: the one validator', () => {
  it('accepts every part, and a single condition where a list goes', () => {
    const parsed = parseInteractive(
      {
        agentUse: 'workstation',
        label: { name: 'PC', lines: [{ when: 'free', text: 'Free' }] },
        panel: 'terminal',
        states: [{ state: 'on', when: 'agentWorking' }],
      },
      ON_OFF,
    );
    expect(parsed).toEqual({
      ok: true,
      interactive: {
        agentUse: 'workstation',
        label: { name: 'PC', lines: [{ when: ['free'], text: 'Free' }] },
        panel: 'terminal',
        states: [{ state: 'on', when: ['agentWorking'] }],
      },
    });
  });

  it('takes every part as optional: an empty block, a label alone, a reaction alone', () => {
    expect(parseInteractive({}, ON_OFF)).toEqual({ ok: true, interactive: {} });
    expect(parseInteractive({ label: { name: 'Plant' } }, new Set())).toEqual({
      ok: true,
      interactive: { label: { name: 'Plant' } },
    });
    expect(parseInteractive({ states: [{ state: 'on', when: ['free'] }] }, ON_OFF)).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ['not an object', 'workstation'],
    ['an array', []],
    ['an unknown key', { agentUse: 'workstation', sound: 'beep' }],
    ['an unknown agent use', { agentUse: 'bed' }],
    ['an agent use named after an object property', { agentUse: 'constructor' }],
    ['a panel named after an object property', { panel: 'toString' }],
    ['a condition named after an object property', { states: [{ state: 'on', when: 'toString' }] }],
    [
      'a placeholder named after an object property',
      { label: { name: 'PC', lines: [{ when: 'free', text: '{toString}' }] } },
    ],
    ['an unknown panel', { panel: 'board' }],
    ['a label without a name', { label: { lines: [] } }],
    ['a label line without text', { label: { name: 'PC', lines: [{ when: 'free' }] } }],
    ['an unknown condition', { states: [{ state: 'on', when: ['raining'] }] }],
    ['an empty condition list', { states: [{ state: 'on', when: [] }] }],
    ['a state the furniture does not declare', { states: [{ state: 'blinking', when: 'free' }] }],
    ['states that are not a list', { states: { state: 'on', when: 'free' } }],
    ['an unknown placeholder', { label: { name: 'PC', lines: [{ when: 'free', text: '{who}' }] } }],
    [
      '{agent} on a line not shown on agentWorking / agentSeated alone',
      { label: { name: 'PC', lines: [{ when: ['agentWorking', 'free'], text: '{agent}' }] } },
    ],
    [
      '{panel} on a line not shown on panelInUse alone',
      { label: { name: 'PC', lines: [{ when: 'free', text: '{panel}' }] } },
    ],
  ])('refuses %s', (_what, raw) => {
    const parsed = parseInteractive(raw, ON_OFF);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toEqual(expect.any(String));
  });
});

describe('withInteractive: where a manifest is read', () => {
  const assets = [
    { id: 'LAMP_OFF', state: 'off' },
    { id: 'LAMP_ON', state: 'on' },
  ];

  it('carries a valid block on every asset of the furniture', () => {
    const warn = vi.fn();
    const out = withInteractive({ states: [{ state: 'on', when: 'free' }] }, assets, 'LAMP', warn);
    expect(out.map((a) => a.interactive)).toEqual([
      { states: [{ state: 'on', when: ['free'] }] },
      { states: [{ state: 'on', when: ['free'] }] },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a malformed block with a warning: the furniture loads as plain furniture', () => {
    const warn = vi.fn();
    const out = withInteractive({ panel: 'board' }, assets, 'LAMP', warn);
    expect(out).toEqual(assets);
    expect(out.some((a) => 'interactive' in a)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('LAMP');
  });

  it('leaves furniture without a block alone', () => {
    const warn = vi.fn();
    expect(withInteractive(undefined, assets, 'LAMP', warn)).toEqual(assets);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says once that electronics with on/off art no longer pair by category', () => {
    const warn = vi.fn();
    const laptop = assets.map((a) => ({ ...a, category: 'electronics' }));
    expect(withInteractive(undefined, laptop, 'LAPTOP', warn)).toEqual(laptop);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/LAPTOP.*agentUse.*workstation/);
    // Electronics without states, or with a block, are not told.
    withInteractive(undefined, [{ id: 'RADIO', category: 'electronics' }], 'RADIO', warn);
    withInteractive({ agentUse: 'workstation' }, laptop, 'LAPTOP', warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('pieceView: the one rules function', () => {
  it('shows a state while its condition holds, the usual sprite otherwise', () => {
    expect(pieceView(PC_LIKE, FREE).state).toBeNull();
    expect(pieceView(PC_LIKE, AGENT).state).toBe('on');
    expect(pieceView(PC_LIKE, SHELL).state).toBe('on');
    expect(pieceView(PC_LIKE, BOTH).state).toBe('on');
  });

  it('takes the first state rule that holds', () => {
    const block: FurnitureInteractive = {
      states: [
        { state: 'busy', when: ['agentWorking'] },
        { state: 'on', when: ['agentWorking', 'panelInUse'] },
        { state: 'off', when: ['free'] },
      ],
    };
    expect(pieceView(block, AGENT).state).toBe('busy');
    expect(pieceView(block, SHELL).state).toBe('on');
    expect(pieceView(block, FREE).state).toBe('off');
  });

  it('labels with the name and the first line whose condition holds, filled in', () => {
    expect(pieceView(PC_LIKE, FREE).label).toEqual({ name: 'PC', line: 'Free' });
    expect(pieceView(PC_LIKE, AGENT).label).toEqual({ name: 'PC', line: 'Ada works here' });
    expect(pieceView(PC_LIKE, SHELL).label).toEqual({ name: 'PC', line: 'Shell in pixel-agents' });
    // Ada's desk while she is idle: hers, not free, and off.
    expect(pieceView(PC_LIKE, SEATED).label).toEqual({ name: 'PC', line: 'Ada works here' });
    expect(pieceView(PC_LIKE, SEATED).state).toBeNull();
    // An agent at work AND a live shell: one line, the first that holds.
    expect(pieceView(PC_LIKE, BOTH).label).toEqual({ name: 'PC', line: 'Shell in pixel-agents' });
    const agentFirst: FurnitureInteractive = {
      label: { name: 'PC', lines: [...PC_LIKE.label!.lines!].reverse() },
    };
    expect(pieceView(agentFirst, BOTH).label?.line).toBe('Ada works here');
    expect(
      pieceView({ label: { name: 'PC', lines: [{ when: ['free'], text: 'Free' }] } }, AGENT),
    ).toEqual({ state: null, label: { name: 'PC', line: null }, click: null });
  });

  it('resolves a click: the live panel, else the agent at work, else a new panel', () => {
    expect(pieceView(PC_LIKE, BOTH).click).toEqual({ kind: 'openPanel', panel: 'terminal' });
    expect(pieceView(PC_LIKE, SHELL).click).toEqual({ kind: 'openPanel', panel: 'terminal' });
    expect(pieceView(PC_LIKE, AGENT).click).toEqual({ kind: 'agentTerminal', agentId: 7 });
    expect(pieceView(PC_LIKE, FREE).click).toEqual({
      kind: 'newPanel',
      panel: 'terminal',
      place: null,
    });
    // Places only matter to a new panel: a live one or an agent's terminal comes first.
    const places = ['web', 'api'];
    expect(pieceView(PC_LIKE, { ...BOTH, places }).click?.kind).toBe('openPanel');
    expect(pieceView(PC_LIKE, { ...AGENT, places }).click?.kind).toBe('agentTerminal');
  });

  it('a new panel opens in its one place at once, asks among several, and takes the default with none', () => {
    expect(pieceView(PC_LIKE, { ...FREE, places: ['web'] }).click).toEqual({
      kind: 'newPanel',
      panel: 'terminal',
      place: 'web',
    });
    expect(pieceView(PC_LIKE, { ...FREE, places: ['web', 'api'] }).click).toEqual({
      kind: 'choosePlace',
      panel: 'terminal',
      places: ['web', 'api'],
    });
    expect(pieceView(PC_LIKE, { ...FREE, places: [] }).click).toMatchObject({ place: null });
  });

  it('offers no click in a read-only office, but still labels and lights', () => {
    const view = pieceView(PC_LIKE, { ...AGENT, readOnly: true });
    expect(view.click).toBeNull();
    expect(view.state).toBe('on');
    expect(view.label?.line).toBe('Ada works here');
  });

  it('answers nothing for each part left out', () => {
    for (const facts of [FREE, AGENT, SHELL, BOTH]) {
      expect(pieceView(undefined, facts)).toEqual({ state: null, label: null, click: null });
      expect(pieceView({}, facts)).toEqual({ state: null, label: null, click: null });
    }
    const labelOnly = pieceView({ label: { name: 'Plant' } }, AGENT);
    expect(labelOnly).toEqual({ state: null, label: { name: 'Plant', line: null }, click: null });
    const panelOnly = pieceView({ panel: 'terminal' }, FREE);
    expect(panelOnly).toEqual({
      state: null,
      label: null,
      click: { kind: 'newPanel', panel: 'terminal', place: null },
    });
  });
});

describe('the PC as it ships', () => {
  let pc: FurnitureInteractive;
  let catalog: NonNullable<ReturnType<typeof createFurnitureCatalog>>;

  beforeAll(async () => {
    const loaded = await loadFurnitureAssets(ASSETS_ROOT);
    if (!loaded) throw new Error('bundled furniture did not load');
    catalog = createFurnitureCatalog(loaded.catalog)!;
    pc = catalogEntry(catalog, 'PC_FRONT_OFF')!.interactive!;
  });

  it('declares agent use workstation, a label, panel terminal, and on while used', () => {
    expect(pc.agentUse).toBe('workstation');
    expect(pc.panel).toBe('terminal');
    expect(pc.label?.name).toBe('PC');
    expect(pieceView(pc, FREE).state).toBeNull();
    expect(pieceView(pc, AGENT).state).toBe('on');
    expect(pieceView(pc, SHELL).state).toBe('on');
    expect(pieceView(pc, FREE).label?.line).toBe('Free');
    expect(pieceView(pc, AGENT).label?.line).toContain('Ada');
    expect(pieceView(pc, SHELL).label?.line).toContain('pixel-agents');
    // One line that says what a click opens: the shell over the agent working there.
    expect(pieceView(pc, BOTH).label?.line).toContain('pixel-agents');
    expect(pieceView(pc, BOTH).click?.kind).toBe('openPanel');
  });

  it('carries its block on every orientation, the mirrored one too', () => {
    for (const type of ['PC_FRONT_OFF', 'PC_FRONT_ON_1', 'PC_BACK', 'PC_SIDE', 'PC_SIDE:left']) {
      expect(catalogEntry(catalog, type)?.interactive, type).toEqual(pc);
    }
  });

  it('has "on" art facing front only: the others show their usual sprite', () => {
    expect(stateVariantOf(catalog, 'PC_FRONT_OFF', 'on')).toBe('PC_FRONT_ON_1');
    expect(stateVariantOf(catalog, 'PC_FRONT_ON_1', 'on')).toBe('PC_FRONT_ON_1');
    expect(stateVariantOf(catalog, 'PC_FRONT_ON_1', 'off')).toBe('PC_FRONT_OFF');
    expect(stateVariantOf(catalog, 'PC_BACK', 'on')).toBeNull();
    expect(stateVariantOf(catalog, 'PC_SIDE:left', 'on')).toBeNull();
  });

  it("is read the same by the office's own manifest reader (the dev server's catalogue)", () => {
    const built = buildFurnitureCatalog(path.join(ASSETS_ROOT, 'assets'));
    const front = built.find((a) => a.id === 'PC_FRONT_OFF');
    expect(front?.interactive).toEqual(pc);
  });
});

describe('furniture from an external asset directory', () => {
  let dir: string;
  const warn = vi.spyOn(console, 'warn');

  afterEach(() => {
    removeTempDir(dir);
    warn.mockClear();
  });

  function furnitureFolder(interactive: unknown): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-furniture-'));
    const folder = path.join(dir, 'assets', 'furniture', 'LAMP');
    fs.mkdirSync(folder, { recursive: true });
    // The plant's art stands in for the lamp's.
    fs.copyFileSync(
      path.join(ASSETS_ROOT, 'assets', 'furniture', 'PLANT', 'PLANT.png'),
      path.join(folder, 'LAMP.png'),
    );
    fs.writeFileSync(
      path.join(folder, 'manifest.json'),
      JSON.stringify({
        id: 'LAMP',
        name: 'Lamp',
        category: 'decor',
        type: 'asset',
        width: 16,
        height: 32,
        footprintW: 1,
        footprintH: 2,
        canPlaceOnWalls: false,
        canPlaceOnSurfaces: false,
        backgroundTiles: 0,
        interactive,
      }),
    );
    return dir;
  }

  it('goes through the same validation: a valid block is carried', async () => {
    const loaded = await loadAllFurniture(ASSETS_ROOT, [
      furnitureFolder({ label: { name: 'Lamp' } }),
    ]);
    const lamp = loaded?.catalog.find((a) => a.id === 'LAMP');
    expect(lamp?.interactive).toEqual({ label: { name: 'Lamp' } });
  });

  it('loads as plain furniture with a logged warning when its block is malformed', async () => {
    const loaded = await loadAllFurniture(ASSETS_ROOT, [furnitureFolder({ agentUse: 'bed' })]);
    const lamp = loaded?.catalog.find((a) => a.id === 'LAMP');
    expect(lamp).toBeDefined();
    expect(lamp).not.toHaveProperty('interactive');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('LAMP'))).toBe(true);
  });

  it("is read the same by the office's own manifest reader", () => {
    const built = buildFurnitureCatalog(path.join(furnitureFolder({ panel: 'board' }), 'assets'));
    expect(built).toHaveLength(1);
    expect(built[0]).not.toHaveProperty('interactive');
  });
});
