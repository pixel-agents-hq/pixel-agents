import {
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  TOOL_BADGE_ASK_COLOR,
  TOOL_BADGE_BASH_COLOR,
  TOOL_BADGE_EDIT_COLOR,
  TOOL_BADGE_FALLBACK_COLOR,
  TOOL_BADGE_GLOB_COLOR,
  TOOL_BADGE_GREP_COLOR,
  TOOL_BADGE_NOTEBOOK_COLOR,
  TOOL_BADGE_OUTLINE_COLOR,
  TOOL_BADGE_READ_COLOR,
  TOOL_BADGE_SIZE_PX,
  TOOL_BADGE_SKILL_COLOR,
  TOOL_BADGE_TASK_COLOR,
  TOOL_BADGE_TODO_COLOR,
  TOOL_BADGE_VERTICAL_OFFSET_PX,
  TOOL_BADGE_WEB_FETCH_COLOR,
  TOOL_BADGE_WEB_SEARCH_COLOR,
  TOOL_BADGE_WRITE_COLOR,
} from '../../constants.js';
import type { Character } from '../types.js';
import { CharacterState } from '../types.js';

type IconPixels = readonly string[];

interface ToolIcon {
  color: string;
  pixels: IconPixels;
}

const ICON_READ: IconPixels = [
  '.........',
  '.XXX.XXX.',
  'X...X...X',
  'X...X...X',
  'X...X...X',
  'X...X...X',
  'X...X...X',
  '.XXX.XXX.',
  '.........',
];

const ICON_GREP: IconPixels = [
  '.XXXXX...',
  'X.....X..',
  'X.....X..',
  'X.....X..',
  'X.....X..',
  '.XXXXX.X.',
  '......XX.',
  '.......XX',
  '........X',
];

const ICON_GLOB: IconPixels = [
  '....X....',
  'X...X...X',
  '.X..X..X.',
  '..X.X.X..',
  'XXXXXXXXX',
  '..X.X.X..',
  '.X..X..X.',
  'X...X...X',
  '....X....',
];

const ICON_BASH: IconPixels = [
  '.........',
  'XX.......',
  '.XX......',
  '..XX.....',
  '...XX....',
  '..XX.....',
  '.XX......',
  'XX..XXXXX',
  '.........',
];

const ICON_EDIT: IconPixels = [
  '.......XX',
  '......XXX',
  '.....XXX.',
  '....XXX..',
  '...XXX...',
  '..XXX....',
  '.XXX.....',
  'XXX......',
  'XX.......',
];

const ICON_WRITE: IconPixels = [
  'XXXXXX...',
  'X....X...',
  'X....X...',
  'X.XX.X...',
  'X....X...',
  'X.XX.X...',
  'X....X...',
  'X....X...',
  'XXXXXX...',
];

const ICON_WEB: IconPixels = [
  '...XXX...',
  '.XX...XX.',
  'X..X.X..X',
  'X.XXXXX.X',
  'XXX...XXX',
  'X.XXXXX.X',
  'X..X.X..X',
  '.XX...XX.',
  '...XXX...',
];

const ICON_TASK: IconPixels = [
  '...XXX...',
  '.XXXXXXX.',
  '.X.....X.',
  'XX.....XX',
  'XX.....XX',
  'XX.....XX',
  '.X.....X.',
  '.XXXXXXX.',
  '...XXX...',
];

const ICON_CHECK: IconPixels = [
  '.........',
  '........X',
  '.......XX',
  '......XX.',
  '.....XX..',
  'X...XX...',
  'XX.XX....',
  '.XXX.....',
  '..X......',
];

const ICON_STAR: IconPixels = [
  '....X....',
  '....X....',
  '...XXX...',
  'XXXXXXXXX',
  '.XXXXXXX.',
  '..XXXXX..',
  '.XX.X.XX.',
  '.X...X.X.',
  'X.....X..',
];

const ICON_HELP: IconPixels = [
  '.XXXXX...',
  'X.....X..',
  'X.....X..',
  '.....X...',
  '....X....',
  '....X....',
  '.........',
  '....X....',
  '.........',
];

const ICONS: Record<string, ToolIcon> = {
  Read: { color: TOOL_BADGE_READ_COLOR, pixels: ICON_READ },
  Grep: { color: TOOL_BADGE_GREP_COLOR, pixels: ICON_GREP },
  Glob: { color: TOOL_BADGE_GLOB_COLOR, pixels: ICON_GLOB },
  Bash: { color: TOOL_BADGE_BASH_COLOR, pixels: ICON_BASH },
  Edit: { color: TOOL_BADGE_EDIT_COLOR, pixels: ICON_EDIT },
  Write: { color: TOOL_BADGE_WRITE_COLOR, pixels: ICON_WRITE },
  NotebookEdit: { color: TOOL_BADGE_NOTEBOOK_COLOR, pixels: ICON_WRITE },
  WebFetch: { color: TOOL_BADGE_WEB_FETCH_COLOR, pixels: ICON_WEB },
  WebSearch: { color: TOOL_BADGE_WEB_SEARCH_COLOR, pixels: ICON_WEB },
  Task: { color: TOOL_BADGE_TASK_COLOR, pixels: ICON_TASK },
  Agent: { color: TOOL_BADGE_TASK_COLOR, pixels: ICON_TASK },
  TodoWrite: { color: TOOL_BADGE_TODO_COLOR, pixels: ICON_CHECK },
  Skill: { color: TOOL_BADGE_SKILL_COLOR, pixels: ICON_STAR },
  AskUserQuestion: { color: TOOL_BADGE_ASK_COLOR, pixels: ICON_HELP },
};

const FALLBACK: ToolIcon = { color: TOOL_BADGE_FALLBACK_COLOR, pixels: ICON_HELP };

function iconFor(tool: string): ToolIcon {
  return ICONS[tool] ?? FALLBACK;
}

export function renderToolBadges(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  for (const ch of characters) {
    if (!ch.currentTool) continue;
    if (ch.bubbleType === 'permission') continue;

    const icon = iconFor(ch.currentTool);
    const { color, pixels } = icon;

    const sittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
    const centerX = offsetX + ch.x * zoom;
    const topY =
      offsetY +
      (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX - TOOL_BADGE_VERTICAL_OFFSET_PX) * zoom -
      TOOL_BADGE_SIZE_PX * zoom;

    const bx = Math.round(centerX - (TOOL_BADGE_SIZE_PX * zoom) / 2);
    const by = Math.round(topY);

    for (let py = 0; py < pixels.length; py++) {
      const row = pixels[py];
      for (let px = 0; px < row.length; px++) {
        const c = row.charCodeAt(px);
        if (c === 46) continue;

        ctx.fillStyle = TOOL_BADGE_OUTLINE_COLOR;
        ctx.fillRect(bx + (px - 1) * zoom, by + py * zoom, zoom, zoom);
        ctx.fillRect(bx + (px + 1) * zoom, by + py * zoom, zoom, zoom);
        ctx.fillRect(bx + px * zoom, by + (py - 1) * zoom, zoom, zoom);
        ctx.fillRect(bx + px * zoom, by + (py + 1) * zoom, zoom, zoom);
      }
    }

    for (let py = 0; py < pixels.length; py++) {
      const row = pixels[py];
      for (let px = 0; px < row.length; px++) {
        const c = row.charCodeAt(px);
        if (c === 46) continue;
        ctx.fillStyle = color;
        ctx.fillRect(bx + px * zoom, by + py * zoom, zoom, zoom);
      }
    }
  }

  ctx.restore();
}
