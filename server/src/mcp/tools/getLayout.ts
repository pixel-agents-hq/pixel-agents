import { z } from 'zod';

import {
  findArea,
  FURNITURE_CATEGORY_IDS,
  furnitureItems,
  layoutSummary,
  tileChart,
} from '../layoutView.js';
import { defineTool, ok, refuse } from '../tool.js';

const rect = z
  .object({
    col: z.number().int().describe('Left column of the rectangle.'),
    row: z.number().int().describe('Top row of the rectangle.'),
    width: z.number().int().min(1).describe('Columns it spans.'),
    height: z.number().int().min(1).describe('Rows it spans.'),
  })
  .describe('A rectangle of tiles: { col, row, width, height }.');

export const getLayout = defineTool({
  name: 'get_layout',
  title: 'Get the office layout',
  description:
    'Read the Pixel Agents office layout at the depth you need. `summary` (default): grid size, ' +
    'tile counts, each Area (what people call a room: label, #rrggbb colour and a plain colour name, ' +
    'map letter, bounding box, tile count, the Directories mapped to it, seats and the ids of its free ' +
    'seats), seats outside any Area, furniture counts by category — no per-item list. `furniture`: ' +
    "the summary plus every placed item (uid, type, label, category, col/row of its footprint's " +
    'top-left tile, footprint, orientation, on/off state, colour, Area), narrowed by `area`, ' +
    '`category` and/or `rect` (all given filters apply). `tiles`: the summary plus an ASCII map of the ' +
    "grid (wall / floor / void / Area letter, with a legend), cropped to `area`'s bounding box and/or " +
    '`rect`. Use list_catalog for what can be placed.',
  input: {
    detail: z
      .enum(['summary', 'furniture', 'tiles'])
      .optional()
      .describe('How much to return (default summary).'),
    area: z
      .string()
      .optional()
      .describe('An Area label (case-insensitive): filters furniture, crops the map.'),
    category: z
      .enum(FURNITURE_CATEGORY_IDS)
      .optional()
      .describe('Only furniture of this category.'),
    rect: rect.optional(),
  },
  changes: false,
  uses: ['layout'],
  run: ({ detail = 'summary', area, category, rect: box }, { office }) => {
    const snapshot = office.layout.getLayout();
    if (!snapshot) return refuse('The office has no layout yet. Open the office once, then retry.');
    let areaLabel: string | undefined;
    if (area !== undefined) {
      const found = findArea(snapshot.layout, area);
      if (!found) {
        const known = (snapshot.layout.areas ?? []).map((a) => `"${a.label}"`).join(', ');
        return refuse(
          `No Area "${area}". ${known ? `Areas: ${known}.` : 'The layout has no Areas.'}`,
        );
      }
      areaLabel = found;
    }
    const summary = layoutSummary(snapshot);
    if (detail === 'summary') return ok({ detail, ...summary });
    if (detail === 'furniture') {
      const furniture = furnitureItems(snapshot, { area: areaLabel, category, rect: box });
      return ok({ detail, ...summary, furniture });
    }
    const map = tileChart(snapshot.layout, { area: areaLabel, rect: box });
    if (!map)
      return refuse(
        `Nothing to map: the crop lies outside the ${snapshot.layout.cols}×${snapshot.layout.rows} grid` +
          (areaLabel ? ` or Area "${areaLabel}" has no tiles there` : '') +
          '.',
      );
    return ok({ detail, ...summary, map });
  },
});
