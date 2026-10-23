import { describe, expect, it } from 'vitest';

import { TV_MODE_STORAGE_KEY } from '../src/tvMode/constants.js';
import type { StorageLike, TvChromeElement } from '../src/tvMode/tvModeState.js';
import {
  loadTvPreference,
  resolveInitialTvMode,
  saveTvPreference,
  showsIn,
  TV_CHROME_ELEMENTS,
  tvKeyAction,
  tvModeFromUrl,
  visibleInTvMode,
} from '../src/tvMode/tvModeState.js';

/** An in-memory Storage. */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

/** A Storage whose every call throws (blocked site data, some private windows). */
const throwingStorage: StorageLike = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('quota', 'QuotaExceededError');
  },
};

describe('tvModeFromUrl', () => {
  it('reads ?tv=1 as TV mode, and the bare / true spellings too', () => {
    expect(tvModeFromUrl('?tv=1')).toBe(true);
    expect(tvModeFromUrl('?tv')).toBe(true);
    expect(tvModeFromUrl('?tv=true')).toBe(true);
    expect(tvModeFromUrl('?tv=on')).toBe(true);
  });

  it('works alongside the server token, in either order', () => {
    expect(tvModeFromUrl('?token=abc123&tv=1')).toBe(true);
    expect(tvModeFromUrl('?tv=1&token=abc123')).toBe(true);
    expect(tvModeFromUrl('?token=abc123&tv=0')).toBe(false);
  });

  it('leaves the token itself intact (other params are not consumed)', () => {
    const search = '?token=abc123&tv=1';
    expect(new URLSearchParams(search).get('token')).toBe('abc123');
    expect(tvModeFromUrl(search)).toBe(true);
  });

  it('is an explicit false for ?tv=0 (a bookmark can escape the remembered choice)', () => {
    expect(tvModeFromUrl('?tv=0')).toBe(false);
    expect(tvModeFromUrl('?tv=false')).toBe(false);
    expect(tvModeFromUrl('?tv=nonsense')).toBe(false);
  });

  it('has no opinion without the param', () => {
    expect(tvModeFromUrl('')).toBeNull();
    expect(tvModeFromUrl('?token=abc123')).toBeNull();
    expect(tvModeFromUrl('?television=1')).toBeNull();
  });
});

describe('the remembered preference', () => {
  it('round-trips through storage under its key', () => {
    const storage = memoryStorage();
    saveTvPreference(() => storage, true);
    expect(storage.data[TV_MODE_STORAGE_KEY]).toBe('1');
    expect(loadTvPreference(() => storage)).toBe(true);
    saveTvPreference(() => storage, false);
    expect(storage.data[TV_MODE_STORAGE_KEY]).toBe('0');
    expect(loadTvPreference(() => storage)).toBe(false);
  });

  it('is off on a fresh browser or unparseable junk', () => {
    expect(loadTvPreference(() => memoryStorage())).toBe(false);
    expect(loadTvPreference(() => memoryStorage({ [TV_MODE_STORAGE_KEY]: 'yes' }))).toBe(false);
  });

  it('survives a localStorage that throws on every call', () => {
    expect(loadTvPreference(() => throwingStorage)).toBe(false);
    expect(() => saveTvPreference(() => throwingStorage, true)).not.toThrow();
  });

  it('survives a localStorage getter that throws, or no storage at all', () => {
    const noStorage = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(loadTvPreference(noStorage)).toBe(false);
    expect(() => saveTvPreference(noStorage, true)).not.toThrow();
    expect(loadTvPreference(() => null)).toBe(false);
    expect(() => saveTvPreference(() => undefined, true)).not.toThrow();
  });
});

describe('resolveInitialTvMode', () => {
  it('the URL wins when it says anything', () => {
    const on = memoryStorage({ [TV_MODE_STORAGE_KEY]: '1' });
    const off = memoryStorage({ [TV_MODE_STORAGE_KEY]: '0' });
    expect(resolveInitialTvMode('?tv=1', () => off)).toBe(true);
    expect(resolveInitialTvMode('?tv=0', () => on)).toBe(false);
    expect(resolveInitialTvMode('?token=abc&tv=1', () => off)).toBe(true);
  });

  it('falls back to the remembered choice', () => {
    expect(resolveInitialTvMode('', () => memoryStorage({ [TV_MODE_STORAGE_KEY]: '1' }))).toBe(
      true,
    );
    expect(resolveInitialTvMode('?token=abc', () => memoryStorage())).toBe(false);
    expect(resolveInitialTvMode('', () => throwingStorage)).toBe(false);
  });
});

describe('tvKeyAction', () => {
  const body = { tagName: 'BODY' };

  it('T toggles, in either case, in and out of TV mode', () => {
    expect(tvKeyAction({ key: 't' }, body, false)).toBe('toggle');
    expect(tvKeyAction({ key: 'T' }, body, true)).toBe('toggle');
    expect(tvKeyAction({ key: 't' }, null, false)).toBe('toggle');
  });

  it('Esc leaves TV mode and does nothing outside it', () => {
    expect(tvKeyAction({ key: 'Escape' }, body, true)).toBe('exit');
    expect(tvKeyAction({ key: 'Escape' }, body, false)).toBeNull();
  });

  it('ignores typing in inputs, textareas (the terminal), selects and contenteditables', () => {
    expect(tvKeyAction({ key: 't' }, { tagName: 'INPUT' }, false)).toBeNull();
    expect(tvKeyAction({ key: 't' }, { tagName: 'textarea' }, false)).toBeNull();
    expect(tvKeyAction({ key: 'T' }, { tagName: 'SELECT' }, true)).toBeNull();
    expect(
      tvKeyAction({ key: 't' }, { tagName: 'DIV', isContentEditable: true }, false),
    ).toBeNull();
    expect(tvKeyAction({ key: 'Escape' }, { tagName: 'INPUT' }, true)).toBeNull();
  });

  it('ignores modifier chords (Ctrl+T is the browser’s) and auto-repeat', () => {
    expect(tvKeyAction({ key: 't', ctrlKey: true }, body, false)).toBeNull();
    expect(tvKeyAction({ key: 't', metaKey: true }, body, false)).toBeNull();
    expect(tvKeyAction({ key: 't', altKey: true }, body, false)).toBeNull();
    expect(tvKeyAction({ key: 't', repeat: true }, body, false)).toBeNull();
  });

  it('leaves every other key alone', () => {
    expect(tvKeyAction({ key: 'f' }, body, true)).toBeNull();
    expect(tvKeyAction({ key: 'ArrowLeft' }, body, true)).toBeNull();
    expect(tvKeyAction({ key: 'Enter' }, body, false)).toBeNull();
  });
});

describe('what TV mode shows', () => {
  const kept: TvChromeElement[] = [
    'office',
    'agentLabels',
    'dailyStrip',
    'inboxBadge',
    'approvalCard',
    'remoteWorkers',
    'connectionIndicator',
    'exitTvButton',
  ];
  const hidden: TvChromeElement[] = [
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
  ];

  it('keeps the office, the labels, the TODAY strip with its 📥 badge and the approval card', () => {
    for (const el of kept) expect(visibleInTvMode(el), el).toBe(true);
  });

  it('hides every control: zoom, pan, Fit, toolbar, Settings, card bars, editor, banners, Tasks, inbox button', () => {
    for (const el of hidden) expect(visibleInTvMode(el), el).toBe(false);
  });

  it('decides every element there is (nothing falls through by accident)', () => {
    expect([...kept, ...hidden].sort()).toEqual([...TV_CHROME_ELEMENTS].sort());
  });

  it('showsIn draws everything outside TV mode', () => {
    for (const el of TV_CHROME_ELEMENTS) {
      expect(showsIn(el, false), el).toBe(true);
      expect(showsIn(el, true), el).toBe(visibleInTvMode(el));
    }
  });
});
