/**
 * TV mode: the office alone on a TV, a second monitor or a phone — the
 * controls hidden, the browser in fullscreen. The pure decisions live here
 * (the URL param, the keys, the remembered preference, what stays visible);
 * useTvMode.ts wires them to the browser, App.tsx draws by them.
 */

import type { FocusTargetLike } from '../office/camera.js';
import { isEditableTarget } from '../office/camera.js';
import { TV_MODE_STORAGE_KEY } from './constants.js';

// ── URL ──────────────────────────────────────────────────────────────────────

/** What `?tv=` says: true (`?tv=1`, `?tv`, `?tv=true`), false (`?tv=0` and
 *  anything else), or null when the URL has no opinion. Other params (the
 *  server `?token=`) are left alone. */
export function tvModeFromUrl(search: string): boolean | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get('tv');
  } catch {
    return null;
  }
  if (value === null) return null;
  const v = value.trim().toLowerCase();
  return v === '' || v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ── Remembered choice ───────────────────────────────────────────────────────

/** The slice of Storage the preference uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The remembered choice; false when storage is missing, blocked or throws
 *  (private windows, blocked site data — even the `localStorage` getter can
 *  throw, so the accessor runs inside the guard). */
export function loadTvPreference(getStorage: () => StorageLike | null | undefined): boolean {
  try {
    return getStorage()?.getItem(TV_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember the choice; a storage that throws just forgets. */
export function saveTvPreference(
  getStorage: () => StorageLike | null | undefined,
  on: boolean,
): void {
  try {
    getStorage()?.setItem(TV_MODE_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* private window / blocked storage: not remembered */
  }
}

/** The mode to start in: the URL when it says, else the remembered choice.
 *  A `?tv=1` bookmark opens straight into TV mode; a reload without the
 *  param stays where the viewer left it. */
export function resolveInitialTvMode(
  search: string,
  getStorage: () => StorageLike | null | undefined,
): boolean {
  return tvModeFromUrl(search) ?? loadTvPreference(getStorage);
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** The slice of KeyboardEvent the key decision reads. */
export interface TvKeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export type TvKeyAction = 'toggle' | 'exit';

/**
 * What a key does to TV mode: T toggles it, Esc leaves it. Never while
 * typing — an input, a textarea (every terminal pane's xterm input is one),
 * a contenteditable — nor for modifier chords (Ctrl+T is the browser's) or
 * on auto-repeat.
 */
export function tvKeyAction(
  e: TvKeyEventLike,
  target: FocusTargetLike | null | undefined,
  inTvMode: boolean,
): TvKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  if (isEditableTarget(target)) return null;
  if (e.key === 't' || e.key === 'T') return 'toggle';
  if (e.key === 'Escape' && inTvMode) return 'exit';
  return null;
}

// ── What TV mode shows ──────────────────────────────────────────────────────

/** Everything the board draws that TV mode has a say over. */
export const TV_CHROME_ELEMENTS = [
  // Kept: the office is the point, and what it needs read at a distance.
  'office',
  'agentLabels',
  'dailyStrip',
  'inboxBadge',
  'approvalCard',
  'remoteWorkers',
  'connectionIndicator',
  'exitTvButton',
  // Hidden: every control, and everything that would invite one.
  'zoomControls',
  'panPad',
  'fitButton',
  'tvModeButton',
  'bottomToolbar',
  'settingsButton',
  'agentCardBar',
  'terminalDrawer',
  'mobileCardBar',
  'mobileViewToggle',
  'editor',
  'viewOnlyBanner',
  'toasts',
  'tasksButton',
  'inboxButton',
  'remoteWorkersChip',
  'versionIndicator',
  'introBubble',
] as const;

export type TvChromeElement = (typeof TV_CHROME_ELEMENTS)[number];

const KEPT_IN_TV_MODE: ReadonlySet<TvChromeElement> = new Set<TvChromeElement>([
  'office',
  'agentLabels',
  'dailyStrip',
  'inboxBadge',
  'approvalCard',
  'remoteWorkers',
  'connectionIndicator',
  'exitTvButton',
]);

/** Whether `el` is still drawn in TV mode: the office, the agent labels,
 *  the TODAY strip (with a passive 📥 count), approval cards, the desktop
 *  Remote Workers list (background agents' only presence; passive — the
 *  phone's 🤖 chip is a button and goes), the connection status (it only
 *  shows when the board is stale) and the Exit button — nothing else. */
export function visibleInTvMode(el: TvChromeElement): boolean {
  return KEPT_IN_TV_MODE.has(el);
}

/** Whether to draw `el` now: everything outside TV mode, the kept set in it. */
export function showsIn(el: TvChromeElement, tvMode: boolean): boolean {
  return !tvMode || visibleInTvMode(el);
}
