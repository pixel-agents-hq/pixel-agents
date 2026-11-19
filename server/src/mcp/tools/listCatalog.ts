import { z } from 'zod';

import { catalogListing, FURNITURE_CATEGORY_IDS } from '../layoutView.js';
import { defineTool, ok } from '../tool.js';

export const listCatalog = defineTool({
  name: 'list_catalog',
  title: 'List the furniture catalogue',
  description:
    'Everything you can put in the Pixel Agents office, with the rules edit_layout checks. Furniture ' +
    '(optionally one `category`): type, label, category, footprint, background_rows, is_desk, ' +
    'can_place_on_surfaces, can_place_on_walls, and for rotating items every orientation with its own ' +
    'type, footprint and on_type, or states {off, on}. Also the floor patterns, wall sets (by name), ' +
    'carpet variants and pets, the colour formats, and `rules`: how coordinates and placement work.',
  input: {
    category: z
      .enum(FURNITURE_CATEGORY_IDS)
      .optional()
      .describe('Only furniture of this category.'),
  },
  changes: false,
  uses: ['layout'],
  run: ({ category }, { office }) => ok(catalogListing(office.layout.getAssets(), category)),
});
