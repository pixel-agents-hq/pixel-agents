import { z } from 'zod';

import { CHARACTER_PREVIEW_LIMIT } from '../../constants.js';
import type { OfficeCharacter } from '../charactersView.js';
import { defineTool, ok, refuse } from '../tool.js';

/** One character as the tool reports it (snake_case, the agent-facing shape). */
function describeCharacter(c: OfficeCharacter): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    palette: c.palette,
    body: c.body,
    eye_shape: c.eyeShape,
    eye_rows: c.eyeRows,
    parts: c.parts,
    colors: c.colors,
    ...(c.editedPieces.length ? { edited_pieces: c.editedPieces } : {}),
    directories: c.directories,
    agents: c.agents,
  };
}

export const listCharacters = defineTool({
  name: 'list_characters',
  title: 'List characters',
  description:
    'The roster of Pixel Agents characters, in palette order: id (permanent), name, palette index, ' +
    'body, eye shape and rows, the parts worn per slot, the colours set per colour key (each with its ' +
    'exact `value`, plus the named colour or colorway it is, and its hex — `approximate` when that is ' +
    'only the tone it shows), the pixel-edited pieces, the Directories using it as a default ' +
    "character, and the agents wearing it now. Unset colours are the art's own (or a default: see " +
    "list_wardrobe's rules). `preview`: characters to picture (an id, exact name or palette index " +
    'each), returned as PNG images after the JSON, in `previews` order: each one standing facing ' +
    `down, up and right, every sprite pixel a block (at most ${CHARACTER_PREVIEW_LIMIT} a call).`,
  input: {
    preview: z
      .array(z.union([z.string().min(1), z.number().int()]))
      .optional()
      .describe('Characters to picture: ids, exact names or palette indices.'),
  },
  changes: false,
  uses: ['characters'],
  run: ({ preview }, { office }) => {
    const pictured = preview?.length ? office.characters.previews(preview) : null;
    if (pictured && !pictured.ok) return refuse(pictured.reason);
    const { characters, externalSprites } = office.characters.listCharacters();
    const notes: string[] = [];
    if (pictured && pictured.asked > pictured.previews.length) {
      notes.push(
        `Pictured ${pictured.previews.length} of the ${pictured.asked} characters asked for ` +
          `(${CHARACTER_PREVIEW_LIMIT} a call): ask again for the rest.`,
      );
    }
    if (externalSprites > 0) {
      notes.push(
        `Palettes ${characters.length}-${characters.length + externalSprites - 1} are character ` +
          'sprites from external asset folders: they can be launched as, not listed or pictured.',
      );
    }
    return ok(
      {
        characters: characters.map(describeCharacter),
        ...(pictured
          ? { previews: pictured.previews.map(({ id, name, palette }) => ({ id, name, palette })) }
          : {}),
        ...(notes.length ? { notes } : {}),
      },
      pictured?.previews.map((p) => ({ data: p.png, mimeType: 'image/png' as const })),
    );
  },
});
