import { defineTool, ok } from '../tool.js';

export const listWardrobe = defineTool({
  name: 'list_wardrobe',
  title: 'List the character wardrobe',
  description:
    'What Pixel Agents characters are made of. `slots`: each slot (hair, beard, top, jacket, pants, ' +
    'shoes, full = outfit, hat, accessories) with its parts (id, label, colorways: the exact ' +
    'recolourings a part ships with; custom: an item the user saved, drawn like its `base`; has_tie: ' +
    'an outfit with a tie of its own colour). `bodies`, `underwear`, `eye_shapes`, `eye_rows`. ' +
    '`colors`: every colour key with its named colours (name + hex; each part has its own value per ' +
    'name) or, for keys without names, hex swatches (`same_as`: the same offer as that key). `color_formats`: the ways to give a colour. ' +
    '`rules`: slots that exclude each other, the roster limit, how defaults apply. A character is ' +
    '16x32 pixels a frame, so a look is shapes and colours. list_characters shows the roster.',
  input: {},
  changes: false,
  uses: ['characters'],
  run: (_args, { office }) => ok(office.characters.listWardrobe()),
});
