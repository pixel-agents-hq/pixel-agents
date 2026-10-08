import { TERMINAL_SEL_HANDLE_KNOB_PX, TERMINAL_SEL_HANDLE_WIDTH_PX } from '../constants.js';
import type { CellGrid, CellRange, HandleEnd, PixelPos } from './selectionMath.js';
import { copyPillPosition, handlePositions } from './selectionMath.js';
import type { TouchHit } from './touchGesture.js';

/**
 * The chrome of the terminal's touch text selection, laid over the pane's
 * host: a floating "Copy" pill and iOS-style selection handles — a
 * knob-and-bar lollipop at each end of the selection, knob above the start
 * and below the end, each draggable to move that end. Square knob and hard
 * edges to match the pixel design language; same grammar as the native
 * handles this replaces. Styling lives in index.css (`.terminal-copy-pill`,
 * `.terminal-sel-handle`); this module only creates, positions and
 * hit-tests the elements. touchGesture.ts decides when they show.
 */
export interface SelectionOverlay {
  showPill(range: CellRange): void;
  hidePill(): void;
  /** Show the handles (creating them if needed) and position them. */
  showHandles(range: CellRange): void;
  hideHandles(): void;
  /** What a touch event's target is, as the gesture reducer sees it. */
  hitTest(target: EventTarget | null): TouchHit;
  dispose(): void;
}

export function createSelectionOverlay(
  host: HTMLElement,
  opts: {
    /** The cell grid's current geometry (terminalCellGrid). */
    grid: () => CellGrid;
    /** Pill and handles only ever show over a live selection. */
    hasSelection: () => boolean;
    /** The pill was clicked. */
    onCopy: () => void;
  },
): SelectionOverlay {
  let pill: HTMLButtonElement | null = null;
  let handles: Record<HandleEnd, HTMLDivElement> | null = null;

  const place = (el: HTMLElement, pos: PixelPos) => {
    el.style.left = `${String(pos.left)}px`;
    el.style.top = `${String(pos.top)}px`;
  };

  const hidePill = () => {
    pill?.remove();
    pill = null;
  };

  const hideHandles = () => {
    if (!handles) return;
    handles.start.remove();
    handles.end.remove();
    handles = null;
  };

  // The wrapper is the grab surface hitTest() recognizes: a touch strip
  // around a 2px bar one cell tall, capped by the square knob (both drawn
  // by CSS pseudo-elements, so they never hit-test on their own).
  const makeHandle = (end: HandleEnd, cellHeight: number): HTMLDivElement => {
    const el = document.createElement('div');
    el.className = 'terminal-sel-handle';
    el.dataset.handle = end;
    el.style.setProperty('--cell-h', `${String(cellHeight)}px`);
    el.style.setProperty('--sel-handle-w', `${String(TERMINAL_SEL_HANDLE_WIDTH_PX)}px`);
    el.style.setProperty('--sel-knob', `${String(TERMINAL_SEL_HANDLE_KNOB_PX)}px`);
    return el;
  };

  return {
    showPill(range) {
      hidePill();
      if (!opts.hasSelection()) return;
      pill = document.createElement('button');
      pill.className = 'terminal-copy-pill';
      pill.textContent = 'Copy';
      place(pill, copyPillPosition(range, opts.grid()));
      pill.addEventListener('click', opts.onCopy);
      host.appendChild(pill);
    },
    hidePill,
    showHandles(range) {
      if (!opts.hasSelection()) return;
      const grid = opts.grid();
      if (!handles) {
        handles = {
          start: makeHandle('start', grid.cellHeight),
          end: makeHandle('end', grid.cellHeight),
        };
        host.appendChild(handles.start);
        host.appendChild(handles.end);
      }
      const pos = handlePositions(range, grid);
      place(handles.start, pos.start);
      place(handles.end, pos.end);
    },
    hideHandles,
    hitTest(target) {
      if (pill && target instanceof Node && pill.contains(target)) return { kind: 'pill' };
      if (target instanceof HTMLElement) {
        const end = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
        if (end === 'start' || end === 'end') return { kind: 'handle', end };
      }
      return { kind: 'cell' };
    },
    dispose() {
      hidePill();
      hideHandles();
    },
  };
}
