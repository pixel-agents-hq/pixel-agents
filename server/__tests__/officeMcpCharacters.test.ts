/**
 * list_wardrobe and list_characters through the Pixel Office MCP's main seam: a
 * composed standalone server over a temp HOME holding a seeded roster
 * (characters.json), a custom wardrobe item (wardrobe-items.json) and a Directory
 * with default characters (config.json), an agent launched from the office, and
 * the MCP SDK's client calling the tools with that agent's token. Asserted on
 * what the agent gets back: the JSON, and the preview PNGs decoded and compared
 * with the character's sheet as the office draws it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { SWATCHES } from '../../core/src/characters/art/artColors.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { renderCharacterSheet } from '../src/characterArt.js';
import { CHARACTER_PREVIEW_LIMIT, CHARACTER_PREVIEW_SCALE } from '../src/constants.js';
import { type Json, useStandaloneOffice } from './helpers/officeMcpHarness.js';

const ART = path.join(__dirname, '../../core/src/characters/art');
/** The wardrobe's data file: where the named colours' hexes come from. */
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ART, 'wardrobe.json'), 'utf8')) as Json;
/** A category palette's square, as wardrobe.json has it. */
const square = (category: string, name: string): Json =>
  (MANIFEST.palettes[category].squares as Json[]).find((sq) => sq.label === name)!;

/** The six defaults, then two characters both called "Twin" (the first with yellow hair). */
const ROSTER = [
  ...DEFAULT_CHARACTER_PROFILES,
  {
    ...DEFAULT_CHARACTER_PROFILES[2],
    id: 'twin-a',
    name: 'Twin',
    // The hair palette's Yellow square, as wardrobe.json gives it for Spiky.
    colors: { hair: { h: 50, s: 54, b: -14, c: 0, colorize: true } },
  },
  { ...DEFAULT_CHARACTER_PROFILES[3], id: 'twin-b', name: 'Twin' },
];

/** A custom hair item, drawn as the built-in Spiky. */
const ITEM = {
  id: 'custom_flame',
  piece: 'hair',
  label: 'Flame',
  base: 'spiky',
  png: fs.readFileSync(path.join(ART, 'hair', 'spiky.png')).toString('base64'),
};

/** The sheet's 128x96 pixel (x, y) as RGBA. */
function sheetPixel(sheet: Uint8ClampedArray, x: number, y: number): number[] {
  const i = (y * 128 + x) * 4;
  return [...sheet.subarray(i, i + 4)];
}

describe('list_wardrobe and list_characters (composed server, seeded roster)', () => {
  const h = useStandaloneOffice({
    name: 'pxl-mcp-chars',
    grant: true,
    prepare: ({ home, workspace }) => {
      const dir = path.join(home, '.pixel-agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify(ROSTER));
      fs.writeFileSync(path.join(dir, 'wardrobe-items.json'), JSON.stringify([ITEM]));
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          directories: [
            { name: 'Varys', path: workspace, characters: [2, 0] },
            { name: 'Other', path: path.dirname(workspace), characters: [2] },
          ],
        }),
      );
    },
  });

  // ── list_wardrobe ───────────────────────────────────────────

  it('list_wardrobe: parts per slot with colourways, named colours per key, bodies, eyes and rules', async () => {
    const { client } = await h.launchAgent();
    const reply = await h.callTool(client, 'list_wardrobe');
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.images).toEqual([]);
    const w = reply.value!;
    // Compact: it goes into an agent's context.
    expect(reply.text.length).toBeLessThan(24_000);

    const hair = (w.slots as Json[]).find((s) => s.slot === 'hair')!;
    expect(hair.label).toBe('Hair');
    expect(hair.parts).toContainEqual({ id: 'spiky', label: 'Spiky', colorways: ['Original'] });
    // A custom item is worn like a built-in part, marked as one.
    expect(hair.parts).toContainEqual({
      id: 'custom_flame',
      label: 'Flame',
      custom: true,
      base: 'spiky',
      colorways: ['Original'],
    });
    const outfit = (w.slots as Json[]).find((s) => s.slot === 'full')!;
    expect(outfit.label).toBe('Outfit');
    expect(outfit.parts).toContainEqual(
      expect.objectContaining({ id: 'suit_and_tie', has_tie: true }),
    );
    expect(outfit.parts.find((p: Json) => p.id === 'dress').has_tie).toBeUndefined();
    // Bodies and underwear are not slots of their own here.
    expect((w.slots as Json[]).map((s) => s.slot)).not.toContain('body');
    expect((w.slots as Json[]).map((s) => s.slot)).not.toContain('utop');

    expect(w.bodies).toEqual([
      { id: 'flat', label: 'Flat', default_eye_shape: 'plain' },
      { id: 'bust', label: 'Bust', default_eye_shape: 'lashes' },
    ]);
    expect((w.eye_shapes as Json[]).map((e) => e.id)).toEqual([
      'plain',
      'lashes',
      'lidded',
      'stern',
      'closed',
    ]);
    expect(w.eye_rows).toMatchObject({ values: ['top', 'bottom', 'both'], default: 'bottom' });

    const colors = w.colors as Json[];
    /** A key's offer: its own, or the one it is `same_as` (listed once, at the first key). */
    const offer = (key: string): Json => {
      const entry = colors.find((c) => c.key === key)!;
      return entry.same_as ? offer(entry.same_as as string) : entry;
    };
    expect(offer('hair').named).toContainEqual({
      name: 'Yellow',
      hex: square('hair', 'Yellow').hex,
    });
    expect(offer('skin').named.map((n: Json) => n.name)).toEqual(['Pale', 'Light', 'Tan', 'Dark']);
    // The clothes share one palette, listed once.
    expect(colors.find((c) => c.key === 'shoes')!.named).toBeUndefined();
    expect(offer('shoes').named).toContainEqual({
      name: 'Orange',
      hex: square('shoes', 'Orange').hex,
    });
    expect(offer('shoes')).toBe(offer('top'));
    // Keys with no category palette: hex swatches fitted to the part.
    expect(offer('eyes').named).toBeUndefined();
    expect(offer('eyes').swatches).toEqual([...SWATCHES.eyes]);
    expect(offer('tie').swatches).toEqual([...SWATCHES.default]);
    expect(colors.map((c) => c.key)).toEqual(
      expect.arrayContaining(['skin', 'eyes', 'lashes', 'top', 'pants', 'shoes', 'full', 'tie']),
    );

    expect(w.rules).toMatchObject({ roster_limit: 500 });
    expect(w.rules.exclusive_slots).toEqual([['full', 'top']]);
    expect(JSON.stringify(w.color_formats)).toMatch(/colorway/);
  });

  // ── list_characters ─────────────────────────────────────────

  it('list_characters: each character with its parts, readable colours, Directories and wearers', async () => {
    const { client, id } = await h.launchAgent();
    const reply = await h.callTool(client, 'list_characters');
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.images).toEqual([]);
    const characters = reply.value!.characters as Json[];
    expect(characters.map((c) => [c.palette, c.id, c.name])).toEqual([
      [0, 'char-0', 'Byte'],
      [1, 'char-1', 'Nova'],
      [2, 'char-2', 'Pip'],
      [3, 'char-3', 'Echo'],
      [4, 'char-4', 'Dot'],
      [5, 'char-5', 'Volt'],
      [6, 'twin-a', 'Twin'],
      [7, 'twin-b', 'Twin'],
    ]);

    const suit = characters[0];
    expect(suit).toMatchObject({
      body: 'flat',
      eye_shape: 'plain',
      eye_rows: 'bottom',
      parts: {
        hair: { id: 'mop', label: 'Mop' },
        full: { id: 'business_suit', label: 'Business suit' },
        shoes: { id: 'boots', label: 'Boots' },
        under: { id: 'basic', label: 'Underwear' },
      },
      directories: ['Varys'],
    });
    expect(suit.parts.top).toBeUndefined();
    // A colourway is named as one; any colour carries its exact value and a hex.
    expect(suit.colors.shoes).toMatchObject({
      colorway: 'Black',
      value: { h: 0, s: 0, b: 0, c: 0, palette: 'Black' },
    });
    expect(suit.colors.shoes.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(suit.colors.hair.value).toEqual({ h: 29, s: 42, b: -18, c: 6, colorize: true });
    expect(suit.colors.hair.hex).toMatch(/^#[0-9a-f]{6}$/);

    // A palette square reads back by its name.
    expect(characters[6].colors.hair).toMatchObject({ name: 'Yellow' });

    // Pip is a default of two Directories, in their order.
    expect(characters[2].directories).toEqual(['Varys', 'Other']);
    expect(characters[1].directories).toEqual([]);

    // The launched agent is listed under the character it wears.
    const agent = (await h.listAgents(client)).find((a) => a.id === id)!;
    const worn = characters[agent.character.palette as number];
    expect(worn.agents).toContain(id);
    expect(characters.filter((c) => (c.agents as number[]).includes(id))).toHaveLength(1);
  });

  // ── Previews ────────────────────────────────────────────────

  it('preview: one PNG per named character (by id, exact name, palette index), its standing frames as drawn', async () => {
    const { client } = await h.launchAgent();
    const reply = await h.callTool(client, 'list_characters', {
      preview: ['char-1', 'Volt', 0],
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value!.previews).toEqual([
      { id: 'char-1', name: 'Nova', palette: 1 },
      { id: 'char-5', name: 'Volt', palette: 5 },
      { id: 'char-0', name: 'Byte', palette: 0 },
    ]);
    expect(reply.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/png', 'image/png']);

    // Volt's picture: down, up and right standing frames (column 1 of each sheet row), side by side.
    const png = PNG.sync.read(Buffer.from(reply.images[1].data, 'base64'));
    const scale = CHARACTER_PREVIEW_SCALE;
    expect([png.width, png.height]).toEqual([3 * 16 * scale, 32 * scale]);
    const sheet = renderCharacterSheet(ROSTER[5]);
    let opaque = 0;
    for (let dir = 0; dir < 3; dir++) {
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 16; x++) {
          const want = sheetPixel(sheet, 16 + x, dir * 32 + y);
          // Every screen pixel of the block is the sheet pixel.
          for (const [dx, dy] of [
            [0, 0],
            [scale - 1, scale - 1],
          ]) {
            const i = ((y * scale + dy) * png.width + dir * 16 * scale + x * scale + dx) * 4;
            expect([...png.data.subarray(i, i + 4)]).toEqual(want);
          }
          if (want[3] > 0) opaque++;
        }
      }
    }
    expect(opaque).toBeGreaterThan(300);
  });

  it('a preview past the limit is cut, and the reply says so', async () => {
    const { client } = await h.launchAgent();
    const all = ROSTER.map((p) => p.id);
    expect(all.length).toBeGreaterThan(CHARACTER_PREVIEW_LIMIT);
    const reply = await h.callTool(client, 'list_characters', { preview: all });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.images).toHaveLength(CHARACTER_PREVIEW_LIMIT);
    expect(reply.value!.previews).toHaveLength(CHARACTER_PREVIEW_LIMIT);
    expect(reply.value!.notes.join(' ')).toMatch(
      new RegExp(`${CHARACTER_PREVIEW_LIMIT} of the ${all.length}`),
    );
  });

  it('refuses an ambiguous name with the matching ids, and a character that does not exist', async () => {
    const { client } = await h.launchAgent();
    const twin = await h.callTool(client, 'list_characters', { preview: ['Twin'] });
    expect(twin.isError).toBe(true);
    expect(twin.text).toMatch(/2 characters are called Twin/);
    expect(twin.text).toContain('twin-a');
    expect(twin.text).toContain('twin-b');
    // By id, either twin is one character.
    const byId = await h.callTool(client, 'list_characters', { preview: ['twin-b'] });
    expect(byId.value!.previews).toEqual([{ id: 'twin-b', name: 'Twin', palette: 7 }]);

    const nobody = await h.callTool(client, 'list_characters', { preview: ['Nobody'] });
    expect(nobody.isError).toBe(true);
    expect(nobody.text).toMatch(/no character called Nobody/);
    const outside = await h.callTool(client, 'list_characters', { preview: [42] });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/no character 42/);
  });
});
