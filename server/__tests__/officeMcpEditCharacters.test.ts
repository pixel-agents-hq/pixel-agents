/**
 * edit_characters through the Pixel Office MCP's main seam: a composed
 * standalone server over a temp HOME holding the six default characters and two
 * user Directories with default characters (config.json), an agent launched
 * from the office, and the MCP SDK's client calling the tools with that agent's
 * token. Asserted on what the agent gets back (the JSON and the previews), what
 * lands on disk (characters.json, config.json) and what every office is sent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CharacterProfile, MAX_CHARACTER_PROFILES } from '../../core/src/characterProfiles.js';
import { SWATCHES } from '../../core/src/characters/art/artColors.js';
import { newProfile, randomize } from '../../core/src/characters/profiles.js';
import { colorArt, EYE_SHAPES } from '../../core/src/characters/slots.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { characterRenderer, renderCharacterSheet } from '../src/characterArt.js';
import { CHARACTER_PREVIEW_SCALE } from '../src/constants.js';
import { applyCharacterOps } from '../src/mcp/characterEditOps.js';
import { createCharacterEdits } from '../src/mcp/characterEdits.js';
import { type Json, useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

/** Hexes an agent might send: an eye swatch, and any colour for a part with a palette. */
const EYE_HEX = SWATCHES.eyes[SWATCHES.eyes.length - 1];
const PANTS_HEX = SWATCHES.default[1];

/** The Naruto create, as the spec's flow sends it. */
const NARUTO = {
  op: 'create_character',
  name: 'Naruto',
  ref: 'naruto',
  body: 'flat',
  parts: { hair: 'spiky', top: 'tshirt', pants: 'low_cut_jeans', shoes: 'boots' },
  colors: {
    hair: { name: 'Yellow' },
    top: { name: 'Orange' },
    pants: { name: 'Orange' },
    shoes: { colorway: 'Black' },
    eyes: { hex: EYE_HEX },
  },
};

describe('edit_characters (composed server, default roster, two Directories)', () => {
  const h = useStandaloneOffice({
    name: 'pxl-mcp-edit-chars',
    grant: true,
    launch: true,
    prepare: ({ home, workspace }) => {
      for (const sub of ['varys', 'other']) fs.mkdirSync(path.join(workspace, sub));
      const dir = path.join(home, '.pixel-agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          directories: [
            { name: 'Client / varys', path: path.join(workspace, 'varys'), characters: [2, 0] },
            { name: 'Other', path: path.join(workspace, 'other'), characters: [2, 4] },
          ],
        }),
      );
    },
  });

  const charactersFile = () => path.join(h.home, '.pixel-agents', 'characters.json');
  const onDisk = (): Json[] | null =>
    fs.existsSync(charactersFile())
      ? (JSON.parse(fs.readFileSync(charactersFile(), 'utf8')) as Json[])
      : null;
  const config = (): Json =>
    JSON.parse(fs.readFileSync(path.join(h.home, '.pixel-agents', 'config.json'), 'utf8')) as Json;
  const defaultsOf = (name: string): number[] | undefined =>
    (config().directories as Json[]).find((d) => d.name === name)?.characters;

  const edit = (client: Parameters<typeof h.callTool>[0], ops: Json[]) =>
    h.callTool(client, 'edit_characters', { ops });

  it('the Naruto flow: create + add_to_directory in one batch, saved, shown, pictured; then launched by name', async () => {
    const { client } = await h.launchAgent();
    const before = h.received.length;
    const reply = await edit(client, [
      NARUTO,
      { op: 'add_to_directory', character: 'naruto', directory: 'Client / varys' },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    const value = reply.value!;
    expect(value.created).toEqual([
      { op: 0, id: expect.stringMatching(/^c/), name: 'Naruto', ref: 'naruto', palette: 6 },
    ]);
    const id = value.created[0].id as string;
    expect(value.directories).toEqual([
      {
        directory: 'Client / varys',
        characters: [
          { id: 'char-2', name: 'Pip', palette: 2 },
          { id: 'char-0', name: 'Byte', palette: 0 },
          { id, name: 'Naruto', palette: 6 },
        ],
      },
    ]);
    expect(value.previews).toEqual([{ id, name: 'Naruto', palette: 6 }]);

    // On disk: the roster, and the Directory's defaults.
    const saved = onDisk()!;
    expect(saved).toHaveLength(7);
    const naruto = saved[6];
    expect(naruto).toMatchObject({
      id,
      name: 'Naruto',
      hair: 'spiky',
      top: 'tshirt',
      shoes: 'boots',
    });
    expect(naruto.colors.shoes).toEqual({ h: 0, s: 0, b: 0, c: 0, palette: 'Black' });
    expect(defaultsOf('Client / varys')).toEqual([2, 0, 6]);
    expect(defaultsOf('Other')).toEqual([2, 4]);

    // Every office got the list as a foreign one (no saveId), and the Directories again.
    const loaded = await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'characterProfilesLoaded'),
      'the roster broadcast',
    );
    expect(loaded.saveId).toBeUndefined();
    expect((loaded.profiles as Json[])[6].name).toBe('Naruto');
    await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'directoriesLoaded'),
      'the Directories broadcast',
    );

    // The picture is the character as the office draws it.
    expect(reply.images).toHaveLength(1);
    const png = PNG.sync.read(Buffer.from(reply.images[0].data, 'base64'));
    expect([png.width, png.height]).toEqual([
      3 * 16 * CHARACTER_PREVIEW_SCALE,
      32 * CHARACTER_PREVIEW_SCALE,
    ]);
    const sheet = renderCharacterSheet(naruto as never);
    const at = (y: number, x: number) => {
      const i = (y * CHARACTER_PREVIEW_SCALE * png.width + x * CHARACTER_PREVIEW_SCALE) * 4;
      return [...png.data.subarray(i, i + 4)];
    };
    for (let y = 0; y < 32; y += 3) {
      for (let x = 0; x < 16; x++) {
        const i = (y * 128 + 16 + x) * 4;
        expect(at(y, x)).toEqual([...sheet.subarray(i, i + 4)]);
      }
    }

    // launch_agent by name, into the Directory.
    const launched = await h.callTool(client, 'launch_agent', {
      directory: 'Client / varys',
      character: 'Naruto',
      first_message: 'say datebaio',
    });
    expect(launched.isError, launched.text).toBe(false);
    expect(launched.value!.character).toMatchObject({ palette: 6, label: 'Naruto' });
  });

  it('colours resolve by name, colourway, hex and HSBC, exactly as list_wardrobe offers them', async () => {
    const { client } = await h.launchAgent();
    const reply = await edit(client, [
      {
        ...NARUTO,
        colors: {
          ...NARUTO.colors,
          top: { h: 20, s: 80, b: 5, c: 0, colorize: true },
          pants: { hex: PANTS_HEX },
          lashes: { name: 'As drawn' },
        },
      },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    const naruto = onDisk()![6];
    const r = characterRenderer();
    const palette = r.paletteFor(colorArt(naruto as never, 'hair'))!;
    const yellow = palette.squares.findIndex((sq) => sq.label === 'Yellow');
    expect(naruto.colors.hair).toEqual(palette.row[yellow]);
    expect(naruto.colors.top).toEqual({ h: 20, s: 80, b: 5, c: 0, colorize: true });
    expect(naruto.colors.pants).toEqual(
      r.hexValue(colorArt(naruto as never, 'pants'), PANTS_HEX, 0),
    );
    // eyes have no palette: a hex is fitted like the view's swatches
    expect(naruto.colors.eyes).toEqual(
      r.swatchValue(colorArt(naruto as never, 'eyes'), EYE_HEX, 'eyes'),
    );
    expect(naruto.colors.lashes).toEqual({ h: 0, s: 0, b: 0, c: 0 });

    // And list_characters reads them back in the same words.
    const listed = await h.callTool(client, 'list_characters');
    const described = (listed.value!.characters as Json[])[6];
    expect(described.colors.hair).toMatchObject({ name: 'Yellow' });
    expect(described.colors.shoes).toMatchObject({ colorway: 'Black' });
    expect(described.directories).toEqual([]);
  });

  it('an invalid op refuses the whole batch, names the op, and writes nothing', async () => {
    const { client } = await h.launchAgent();
    const before = h.received.length;
    const bad = async (ops: Json[], match: RegExp) => {
      const reply = await edit(client, ops);
      expect(reply.isError).toBe(true);
      expect(reply.text).toMatch(match);
      expect(reply.text).toMatch(/[^.]\. Nothing was changed\.$/);
    };
    await bad(
      [NARUTO, { op: 'update_character', character: 'naruto', parts: { hair: 'mohawk' } }],
      /^op 1 \(update_character\): there is no hair part mohawk/,
    );
    await bad(
      [NARUTO, { op: 'update_character', character: 'Volt', colors: { hair: { name: 'Plaid' } } }],
      /^op 1 \(update_character\): colour hair has no named colour Plaid: they are .*Yellow/,
    );
    await bad(
      [{ ...NARUTO, colors: { shoes: { colorway: 'Neon' } } }],
      /^op 0 \(create_character\): the shoes worn has no colourway Neon: its colourways are .*Black/,
    );
    await bad(
      [{ op: 'update_character', character: 'Volt', parts: { full: 'dress', top: 'tshirt' } }],
      /full and top take each other off/,
    );
    await bad(
      [{ op: 'update_character', character: 'Volt', colors: { tie: { name: 'Red' } } }],
      /colour tie: nothing this character wears takes it/,
    );
    await bad(
      [{ op: 'delete_character', character: 'Nobody' }],
      /There is no character called Nobody/,
    );
    await bad(
      [NARUTO, { op: 'add_to_directory', character: 'naruto', directory: 'Nowhere' }],
      /^op 1 \(add_to_directory\): There is no Directory called Nowhere/,
    );
    // The host's own Directory carries no defaults.
    await bad(
      [{ op: 'add_to_directory', character: 'Volt', directory: 'proj' }],
      /proj is the host's Directory/,
    );
    await bad([{ op: 'delete_character', character: 'char-0' }], /the Intro's greeter wears/);

    expect(onDisk()).toBeNull();
    expect(defaultsOf('Client / varys')).toEqual([2, 0]);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.received.slice(before).some((m) => m.type === 'characterProfilesLoaded')).toBe(false);
  });

  it("deleting a worn character re-looks its agents; a Directory's defaults follow the delete and the batch's own changes", async () => {
    const { client, id } = await h.launchAgent();
    // The agent wears Nova (palette 1); another wears Volt (palette 5, moved to 4 by the delete).
    h.store.get(id)!.palette = 1;
    h.store.get(id)!.repeat = 0;
    const before = h.received.length;
    const reply = await edit(client, [
      NARUTO,
      { op: 'delete_character', character: 'Nova' },
      // Into Other's defaults (Pip, Dot) at the top; Varys keeps Pip, Byte.
      { op: 'add_to_directory', character: 'naruto', directory: 'Other', position: 0 },
      { op: 'remove_from_directory', character: 'Dot', directory: 'Other' },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value!.deleted).toEqual([{ op: 1, id: 'char-1', name: 'Nova' }]);
    expect(reply.value!.created[0].palette).toBe(5);

    const saved = onDisk()!;
    expect(saved.map((p) => p.name)).toEqual(['Byte', 'Pip', 'Echo', 'Dot', 'Volt', 'Naruto']);
    // Varys was only renumbered (Pip 2 → 1); Other is the batch's: Naruto, Pip.
    expect(defaultsOf('Client / varys')).toEqual([1, 0]);
    expect(defaultsOf('Other')).toEqual([5, 1]);

    // The agent wore a deleted character: it got a new look, sent with the list.
    const look = h.store.get(id)!.palette;
    expect(look).not.toBeUndefined();
    expect(look).toBeLessThan(6);
    const loaded = await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'characterProfilesLoaded'),
      'the roster broadcast',
    );
    expect(loaded.agentLooks).toEqual([{ id, palette: look, repeat: expect.any(Number) }]);
  });

  it('changing a worn character keeps its wearers on it, redrawn from the new list', async () => {
    const { client, id } = await h.launchAgent();
    h.store.get(id)!.palette = 5;
    const before = h.received.length;
    const reply = await edit(client, [
      {
        op: 'update_character',
        character: 'Volt',
        name: 'Robert',
        colors: { hair: { name: 'Blue' } },
      },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value!.updated).toEqual([{ op: 0, id: 'char-5', name: 'Robert', palette: 5 }]);
    expect(reply.images).toHaveLength(1);
    expect(h.store.get(id)!.palette).toBe(5);
    const loaded = await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'characterProfilesLoaded'),
      'the roster broadcast',
    );
    expect((loaded.profiles as Json[])[5].name).toBe('Robert');
    expect(onDisk()![5].colors.hair).toBeDefined();
  });

  it('randomize fills what is not given; what is given wins', async () => {
    const { client } = await h.launchAgent();
    const reply = await edit(client, [
      {
        op: 'create_character',
        name: 'Wizard',
        randomize: true,
        parts: { hat: 'plain_cap', full: null },
      },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    const wizard = onDisk()![6];
    expect(wizard.hat).toBe('plain_cap');
    expect(wizard.full).toBeUndefined();
    expect(wizard.body).toEqual(expect.any(String));
  });

  it('an office with an unsaved Characters draft blocks edits; saving, discarding or disconnecting lifts it', async () => {
    const { client } = await h.launchAgent();
    const office = await h.connectOffice();
    const op = [{ op: 'update_character', character: 'Volt', name: 'Bobby' }];

    h.send({ type: 'charactersEditing', dirty: true }, office.socket);
    await new Promise((r) => setTimeout(r, 100));
    const locked = await edit(client, op);
    expect(locked.isError).toBe(true);
    expect(locked.text).toMatch(/unsaved changes in the Characters view/);
    expect(onDisk()).toBeNull();

    h.send({ type: 'charactersEditing', dirty: false }, office.socket);
    await new Promise((r) => setTimeout(r, 100));
    expect((await edit(client, op)).isError).toBe(false);

    h.send({ type: 'charactersEditing', dirty: true }, office.socket);
    await new Promise((r) => setTimeout(r, 100));
    expect((await edit(client, op)).isError).toBe(true);
    office.socket.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(
      (await edit(client, [{ op: 'update_character', character: 'Bobby', name: 'Volt' }])).isError,
    ).toBe(false);
  });

  // ── Undo ────────────────────────────────────────────────────

  const DEFAULT_NAMES = ['Byte', 'Nova', 'Pip', 'Echo', 'Dot', 'Volt'];
  const undo = (client: Parameters<typeof h.callTool>[0]) =>
    h.callTool(client, 'undo_character_edit');
  const lastStatus = (from = 0) =>
    h.received
      .slice(from)
      .filter((m) => m.type === 'agentCharacterEditStatus')
      .pop();

  it('every office hears the edit land (who, what) and what its undo would revert', async () => {
    const { client, id } = await h.launchAgent();
    const before = h.received.length;
    await edit(client, [
      NARUTO,
      { op: 'add_to_directory', character: 'naruto', directory: 'Client / varys' },
      { op: 'update_character', character: 'Volt', name: 'Robert' },
    ]);
    const landed = await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'agentCharacterEditStatus'),
      'the status',
    );
    const me = (await h.listAgents(client)).find((a) => a.id === id)!;
    expect(landed).toEqual({
      type: 'agentCharacterEditStatus',
      agentId: id,
      agentName: me.character.label,
      summary: "created Naruto, changed Robert, changed Client / varys's defaults",
      landed: true,
    });
    // An office connecting now is told what an undo would revert (not that it just landed).
    const office = await h.connectOffice();
    const snapshot = office.received.find((m) => m.type === 'agentCharacterEditStatus');
    expect(snapshot).toMatchObject({ agentId: id, summary: expect.stringMatching(/^created/) });
    expect(snapshot!.landed).toBeUndefined();
  });

  it('undo restores the roster and the Directory defaults together, and re-looks the agents wearing what it removes', async () => {
    const { client, id } = await h.launchAgent();
    await edit(client, [
      NARUTO,
      { op: 'add_to_directory', character: 'naruto', directory: 'Client / varys', position: 0 },
    ]);
    expect(defaultsOf('Client / varys')).toEqual([6, 2, 0]);
    // The agent took to wearing the new character.
    h.store.get(id)!.palette = 6;
    h.store.get(id)!.repeat = 0;

    const before = h.received.length;
    const reply = await undo(client);
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value).toMatchObject({
      undone: true,
      edit_by_agent: id,
      edit: "created Naruto, changed Client / varys's defaults",
      removed: [{ id: expect.stringMatching(/^c/), name: 'Naruto' }],
      directories: [
        {
          directory: 'Client / varys',
          characters: [
            { id: 'char-2', name: 'Pip', palette: 2 },
            { id: 'char-0', name: 'Byte', palette: 0 },
          ],
        },
      ],
    });
    expect(reply.value!.restored).toBeUndefined();
    expect(reply.images).toHaveLength(0);
    expect(onDisk()!.map((p) => p.name)).toEqual(DEFAULT_NAMES);
    expect(defaultsOf('Client / varys')).toEqual([2, 0]);
    expect(defaultsOf('Other')).toEqual([2, 4]);
    const look = h.store.get(id)!.palette!;
    expect(look).toBeLessThan(6);
    const loaded = await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'characterProfilesLoaded'),
      'the roster broadcast',
    );
    expect(loaded.agentLooks).toEqual([{ id, palette: look, repeat: expect.any(Number) }]);
    await waitFor(() => lastStatus(before)?.agentId === undefined || null, 'the button to go');
    expect((await undo(client)).text).toMatch(/no agent Character edit to undo/);
  });

  it('undo of a batch that deleted a character and changed defaults puts back the exact pre-edit state', async () => {
    const { client, id } = await h.launchAgent();
    const diskBefore = onDisk();
    const configBefore = config().directories;
    await edit(client, [
      NARUTO,
      { op: 'delete_character', character: 'Nova' },
      { op: 'update_character', character: 'Volt', colors: { hair: { name: 'Blue' } } },
      { op: 'add_to_directory', character: 'naruto', directory: 'Other', position: 0 },
      { op: 'remove_from_directory', character: 'Dot', directory: 'Other' },
    ]);
    expect(defaultsOf('Client / varys')).toEqual([1, 0]);
    // An agent wears Volt (palette 4 after the delete).
    h.store.get(id)!.palette = 4;

    const reply = await undo(client);
    expect(reply.isError, reply.text).toBe(false);
    // Nova and Volt came back as they were: pictured.
    expect(reply.value!.restored).toEqual([
      { id: 'char-1', name: 'Nova', palette: 1 },
      { id: 'char-5', name: 'Volt', palette: 5 },
    ]);
    expect(reply.images).toHaveLength(2);
    const disk = onDisk()!;
    expect(disk.map((p) => p.name)).toEqual(DEFAULT_NAMES);
    // The roster is the defaults again (the file was absent before the edit).
    expect(diskBefore).toBeNull();
    expect(disk).toEqual(JSON.parse(JSON.stringify(DEFAULT_CHARACTER_PROFILES)));
    expect(config().directories).toEqual(configBefore);
    // Volt's wearer followed Volt back to palette 5.
    expect(h.store.get(id)!.palette).toBe(5);
  });

  it('undo goes newest first; it is refused once the roster or a Directory it touched changed since — tool and button alike', async () => {
    const { client } = await h.launchAgent();
    await edit(client, [{ op: 'update_character', character: 'Volt', name: 'Bobby' }]);
    await edit(client, [{ op: 'update_character', character: 'Bobby', name: 'Robert' }]);
    expect((await undo(client)).isError).toBe(false);
    expect(onDisk()![5].name).toBe('Bobby');

    // The button: the same undo.
    const pressed = h.received.length;
    h.send({ type: 'undoAgentCharacterEdit' });
    await waitFor(
      () => h.received.slice(pressed).find((m) => m.type === 'characterProfilesLoaded'),
      'the undo broadcast',
    );
    expect(onDisk()![5].name).toBe('Volt');

    // An edit, then a person saves the roster over it.
    await edit(client, [NARUTO]);
    const roster = onDisk()!;
    roster[6] = { ...roster[6], name: 'Naruto Uzumaki' };
    const savedAt = h.received.length;
    h.send({ type: 'saveCharacterProfiles', profiles: roster, saveId: 'hand-1' });
    await waitFor(() => {
      const s = lastStatus(savedAt);
      return s && s.agentId === undefined ? s : null;
    }, 'the button to go');
    expect((await undo(client)).text).toMatch(/changed since the last agent Character edit/);
    const refusedAt = h.received.length;
    h.send({ type: 'undoAgentCharacterEdit' });
    const answer = await waitFor(
      () =>
        h.received.slice(refusedAt).find((m) => m.type === 'agentCharacterEditStatus' && m.refused),
      'the refusal',
    );
    expect(answer.refused).toMatch(/changed since/);
    expect(onDisk()![6].name).toBe('Naruto Uzumaki');

    // An edit, then a person changes a Directory it touched.
    await edit(client, [
      { op: 'add_to_directory', character: 'Naruto Uzumaki', directory: 'Other' },
    ]);
    const other = (config().directories as Json[]).find((d) => d.name === 'Other')!;
    const dirAt = h.received.length;
    h.send({ type: 'saveDirectory', ...other, previousPath: other.path, characters: [3] });
    await waitFor(() => {
      const s = lastStatus(dirAt);
      return s && s.agentId === undefined ? s : null;
    }, 'the button to go');
    expect((await undo(client)).text).toMatch(/changed since/);
    expect(defaultsOf('Other')).toEqual([3]);

    // An edit, then characters.json is rewritten on disk (by hand, or the other surface).
    await edit(client, [{ op: 'update_character', character: 'Volt', name: 'Bobby' }]);
    expect(lastStatus()?.agentId).toBeDefined();
    const renamed = onDisk()!;
    renamed[5] = { ...renamed[5], name: 'Roberto' };
    const rewrittenAt = h.received.length;
    fs.writeFileSync(charactersFile(), JSON.stringify(renamed));
    await waitFor(() => {
      const s = lastStatus(rewrittenAt);
      return s && s.agentId === undefined ? s : null;
    }, 'the button to go');
    expect((await undo(client)).text).toMatch(/changed since/);
    expect(onDisk()![5].name).toBe('Roberto');
  });

  it('an unsaved Characters draft blocks undo too', async () => {
    const { client } = await h.launchAgent();
    await edit(client, [{ op: 'update_character', character: 'Volt', name: 'Bobby' }]);
    const office = await h.connectOffice();
    h.send({ type: 'charactersEditing', dirty: true }, office.socket);
    await new Promise((r) => setTimeout(r, 100));
    expect((await undo(client)).text).toMatch(/unsaved changes in the Characters view/);
    expect(onDisk()![5].name).toBe('Bobby');
    h.send({ type: 'charactersEditing', dirty: false }, office.socket);
    await new Promise((r) => setTimeout(r, 100));
    expect((await undo(client)).isError).toBe(false);
  });

  it('a read-only MCP refuses edits', async () => {
    const { client } = await h.launchAgent();
    h.send({ type: 'setOfficeMcpReadOnly', readOnly: true });
    await waitFor(
      () => h.received.find((m) => m.type === 'officeMcpStatus' && m.readOnly === true),
      'read-only',
    );
    const reply = await h.callToolCaught(client, 'edit_characters', { ops: [NARUTO] });
    expect(reply.isError).toBe(true);
    expect((await h.callToolCaught(client, 'undo_character_edit')).isError).toBe(true);
    expect(onDisk()).toBeNull();
  });
});

describe('edit_characters on a full roster', () => {
  const h = useStandaloneOffice({
    name: 'pxl-mcp-edit-full',
    grant: true,
    prepare: ({ home }) => {
      const dir = path.join(home, '.pixel-agents');
      fs.mkdirSync(dir, { recursive: true });
      const full = Array.from({ length: MAX_CHARACTER_PROFILES }, (_, i) => ({
        ...DEFAULT_CHARACTER_PROFILES[i % 6],
        id: `x${i}`,
      }));
      fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify(full));
    },
  });

  it('refuses a create, saying the limit', async () => {
    const { client } = await h.launchAgent();
    const reply = await h.callTool(client, 'edit_characters', { ops: [NARUTO] });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(
      new RegExp(
        `^op 0 \\(create_character\\): the roster is full \\(${MAX_CHARACTER_PROFILES} characters`,
      ),
    );
    // A delete in the same batch first makes room.
    const room = await h.callTool(client, 'edit_characters', {
      ops: [{ op: 'delete_character', character: 'x499' }, NARUTO],
    });
    expect(room.isError, room.text).toBe(false);
  });
});

describe('the Character edit history (what undo will restore)', () => {
  it('records the roster and every Directory whose defaults the edit changed, before and after', () => {
    let roster = DEFAULT_CHARACTER_PROFILES.map((p) => ({ ...p }));
    const directories = [
      { name: 'A', path: '/a', characters: [2, 1] as number[] },
      { name: 'B', path: '/b', characters: [3] as number[] },
      { name: 'Host', path: '/h', characters: null },
    ];
    const edits = createCharacterEdits({
      profiles: () => roster,
      renderer: () => characterRenderer(),
      directories: () => directories.map((d) => ({ ...d })),
      commitProfiles: (profiles) => {
        // As the save path does: A and B renumbered after the delete of palette 1.
        roster = profiles;
        directories[0].characters = [1];
        directories[1].characters = [2];
        return true;
      },
      writeDirectoryCharacters: (writes) => {
        for (const w of writes)
          directories.find((d) => d.path === w.path)!.characters = [...w.characters];
        return true;
      },
      characterRefsChanged: () => {},
      agentName: (id) => `agent ${id}`,
      broadcast: () => {},
    });
    const outcome = edits.edit(7, [
      { op: 'delete_character', character: 1 },
      { op: 'create_character', name: 'New', ref: 'n' },
      { op: 'add_to_directory', character: 'n', directory: 'A', position: 0 },
    ]);
    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect(directories[0].characters).toEqual([5, 1]);
    const [entry] = edits.history();
    expect(entry.agentId).toBe(7);
    expect(entry.agentName).toBe('agent 7');
    expect(entry.roster.before.map((p) => p.id)).toEqual(
      DEFAULT_CHARACTER_PROFILES.map((p) => p.id),
    );
    expect(entry.roster.after).toBe(roster);
    expect(entry.directories).toEqual([
      { path: '/a', name: 'A', before: [2, 1], after: [5, 1] },
      { path: '/b', name: 'B', before: [3], after: [2] },
    ]);
  });

  /** createCharacterEdits over an in-memory roster and Directories, renumbering
   *  as the save path does, with writes that fail on demand. */
  function fakeOffice() {
    const state = {
      roster: DEFAULT_CHARACTER_PROFILES.map((p) => ({ ...p })),
      directories: [
        { name: 'A', path: '/a', characters: [2, 1] as number[] },
        { name: 'B', path: '/b', characters: [5] as number[] },
      ],
      failRoster: 0,
      /** Every roster save from this one on (1-based) fails. */
      failRosterFrom: Infinity,
      rosterSaves: 0,
      failDirectories: 0,
      commits: [] as string[][],
      broadcasts: [] as Json[],
      /** How the office names each agent now (absent: it left). */
      agentNames: new Map<number, string>(),
      refsChanged: 0,
    };
    const edits = createCharacterEdits({
      profiles: () => state.roster,
      renderer: () => characterRenderer(),
      directories: () => state.directories.map((d) => ({ ...d, characters: [...d.characters] })),
      commitProfiles: (profiles) => {
        state.rosterSaves++;
        if (state.rosterSaves >= state.failRosterFrom) return false;
        if (state.failRoster > 0) {
          state.failRoster--;
          return false;
        }
        // Renumber the Directories by id, as characterRemap does (dropping the deleted).
        const ids = (list: typeof profiles) => list.map((p, i) => p.id ?? `char-${i}`);
        const was = ids(state.roster);
        const now = ids(profiles);
        for (const d of state.directories) {
          d.characters = d.characters.map((i) => now.indexOf(was[i])).filter((i) => i >= 0);
        }
        state.roster = profiles;
        state.commits.push(now);
        return true;
      },
      writeDirectoryCharacters: (writes) => {
        if (state.failDirectories > 0) {
          state.failDirectories--;
          return false;
        }
        for (const w of writes)
          state.directories.find((d) => d.path === w.path)!.characters = [...w.characters];
        return true;
      },
      characterRefsChanged: () => state.refsChanged++,
      agentName: (id) => state.agentNames.get(id) ?? `agent ${id}`,
      broadcast: (m) => state.broadcasts.push(m),
    });
    return { state, edits };
  }

  const DELETE_AND_ADD = [
    { op: 'delete_character', character: 1 },
    { op: 'create_character', name: 'New', ref: 'n' },
    { op: 'add_to_directory', character: 'n', directory: 'A', position: 0 },
  ] as const;

  it('names the agent as it was called when it edited, after it left', () => {
    const { state, edits } = fakeOffice();
    state.agentNames.set(7, 'Naruto');
    expect(edits.edit(7, DELETE_AND_ADD as never)).toMatchObject({ ok: true });
    state.agentNames.delete(7);
    expect(edits.statusMessage()).toMatchObject({ agentId: 7, agentName: 'Naruto' });
    expect(edits.undo()).toMatchObject({ ok: true, agentName: 'Naruto' });
  });

  it('a roster that does not validate is refused as a whole, not blamed on an op', () => {
    const { state, edits } = fakeOffice();
    const outcome = edits.edit(7, [
      { op: 'update_character', character: 'Volt', name: 'Robert' },
      // Past zod (a test reaching the ops directly): a colour the validator refuses.
      { op: 'update_character', character: 5, colors: { skin: { h: NaN, s: 0, b: 0, c: 0 } } },
      { op: 'add_to_directory', character: 5, directory: 'A' },
    ] as never);
    expect(outcome).toMatchObject({ ok: false, reason: /does not validate/ });
    expect((outcome as { index?: number }).index).toBeUndefined();
    expect(state.rosterSaves).toBe(0);
  });

  it('an update that changes nothing writes nothing, says so, and leaves nothing to undo', () => {
    const { state, edits } = fakeOffice();
    const outcome = edits.edit(7, [{ op: 'update_character', character: 'Volt', name: 'Volt' }]);
    expect(outcome).toEqual({
      ok: true,
      changed: false,
      created: [],
      updated: [],
      deleted: [],
      directories: [],
      notes: ['op 0 (update_character): nothing changed'],
    });
    expect(state.rosterSaves).toBe(0);
    expect(state.broadcasts).toEqual([]);
    expect(edits.history()).toHaveLength(0);
  });

  it('re-sends the Directories only when the edit wrote some (the save path re-sends what it renumbered)', () => {
    const { state, edits } = fakeOffice();
    expect(
      edits.edit(7, [{ op: 'update_character', character: 'Volt', name: 'Robert' }]),
    ).toMatchObject({ ok: true, changed: true });
    expect(state.refsChanged).toBe(0);
    expect(
      edits.edit(7, [{ op: 'add_to_directory', character: 'Robert', directory: 'A' }]),
    ).toMatchObject({ ok: true, changed: true });
    expect(state.refsChanged).toBe(1);
    // Undo of a roster-only edit: the roster save alone.
    expect(edits.undo()).toMatchObject({ ok: true });
    expect(state.refsChanged).toBe(2);
    expect(edits.undo()).toMatchObject({ ok: true });
    expect(state.refsChanged).toBe(2);
  });

  it('is all or nothing: a failed Directory write puts back the roster the edit replaced (renumbered refs too)', () => {
    const { state, edits } = fakeOffice();
    const startIds = state.roster.map((p) => p.id);
    state.failDirectories = 1;
    const outcome = edits.edit(7, DELETE_AND_ADD as never);
    expect(outcome).toEqual({
      ok: false,
      reason: expect.stringMatching(/could not be saved, so the characters were put back/),
    });
    expect(state.roster.map((p) => p.id)).toEqual(startIds);
    // Nova came back, and so did its place in A's defaults the delete had dropped.
    expect(state.directories.map((d) => d.characters)).toEqual([[2, 1], [5]]);
    expect(edits.history()).toHaveLength(0);
    expect(state.broadcasts.filter((m) => m.agentId !== undefined)).toEqual([]);
  });

  it('says so plainly when putting the roster back fails too', () => {
    const { state, edits } = fakeOffice();
    // The edit's roster save lands, its Directory write fails, and so does the restore's save.
    state.failDirectories = 1;
    state.failRosterFrom = 2;
    const outcome = edits.edit(7, DELETE_AND_ADD as never);
    expect(outcome).toMatchObject({ ok: false, partial: true });
    const { reason } = outcome as { reason: string };
    expect(reason).toMatch(/could not be put back/);
    expect(reason).toMatch(/list_characters/);
    expect(edits.history()).toHaveLength(0);
  });

  it('undo puts back the roster and the Directories, and fails safe when a write fails', () => {
    const { state, edits } = fakeOffice();
    const start = { roster: state.roster, dirs: state.directories.map((d) => [...d.characters]) };
    expect(edits.edit(7, DELETE_AND_ADD as never)).toMatchObject({ ok: true });
    const after = { roster: state.roster, dirs: state.directories.map((d) => [...d.characters]) };
    expect(edits.statusMessage()).toMatchObject({
      agentId: 7,
      summary: "created New, deleted Nova, changed A's defaults",
    });

    // The roster save fails: nothing undone, still undoable.
    state.failRoster = 1;
    expect(edits.undo()).toEqual({
      ok: false,
      reason: expect.stringMatching(/nothing was undone/),
    });
    expect(state.roster).toBe(after.roster);
    // The Directory write fails: the roster goes back to what the edit wrote.
    state.failDirectories = 1;
    expect(edits.undo()).toEqual({
      ok: false,
      reason: expect.stringMatching(/nothing was undone/),
    });
    expect(state.roster.map((p) => p.id)).toEqual(after.roster.map((p) => p.id));
    expect(state.directories.map((d) => d.characters)).toEqual(after.dirs);

    const undone = edits.undo();
    expect(undone).toMatchObject({ ok: true, agentId: 7 });
    expect(state.roster.map((p) => p.id)).toEqual(start.roster.map((p) => p.id));
    expect(state.directories.map((d) => d.characters)).toEqual(start.dirs);
    expect(edits.statusMessage()).toEqual({ type: 'agentCharacterEditStatus' });
  });
});

describe('a randomized look given its own body, eye shape or parts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops the random colours of art the override replaced and draws them again the way randomize does (eyes too)', () => {
    const r = characterRenderer();
    // Count randomize's draws, all at 0.1 (so every chance comes up, eyes coloured).
    let calls = 0;
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      calls++;
      return 0.1;
    });
    const sample = newProfile();
    randomize(r, sample);
    const draws = calls;
    expect(sample.colors?.eyes).toBeDefined();
    // An eye shape whose coloured eye art differs from the random one.
    const shape = EYE_SHAPES.find((s) => {
      const art = colorArt({ ...sample, eyeShape: s.id }, 'eyes');
      return art && art.path !== colorArt(sample, 'eyes')?.path;
    })!;
    expect(shape).toBeDefined();

    // The batch's randomize draws as above; every later draw says no.
    calls = 0;
    random.mockImplementation(() => (calls++ < draws ? 0.1 : 0.9));
    const result = applyCharacterOps(
      {
        profiles: DEFAULT_CHARACTER_PROFILES,
        renderer: r,
        directories: [],
        newId: () => 'c-wizard',
      },
      [{ op: 'create_character', name: 'Wizard', randomize: true, eye_shape: shape.id }],
    );
    expect(result.ok).toBe(true);
    const wizard = (result as { profiles: CharacterProfile[] }).profiles.at(-1)!;
    expect(wizard.eyeShape).toBe(shape.id);
    // The eye colour fitted to the random shape's art is gone; the redraw (0.9: no colour) kept none.
    expect(wizard.colors?.eyes).toBeUndefined();
  });
});
