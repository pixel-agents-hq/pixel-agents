/**
 * The Characters view: design the cast agents are drawn from. Desktop: a modal with
 * three panes (roster | preview and export sheet | wardrobe). Phones: a full-screen page
 * with the preview pinned on top, the wardrobe below and the roster in a bottom dock.
 */

import './characters.css';
import './characters.phone.css';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { PixelIcon } from '../../components/ui/PixelIcon.js';
import {
  CHARACTERS_HERO_MIN_SCALE,
  CHARACTERS_HERO_PER_SHEET,
  CHARACTERS_MIN_WARDROBE_W,
  CHARACTERS_PHONE_SCALES,
  CHARACTERS_SHEET_SCALE,
  CHARACTERS_STATUS_MS,
  CHARACTERS_VIEW_Z_INDEX,
} from '../../constants.js';
import { type BoxSize, useBoxSize } from '../../hooks/useBoxSize.js';
import { useDevicePixelRatio } from '../../hooks/useDevicePixelRatio.js';
import { castStore, useCast } from '../castStore.js';
import { FRAME_COUNT, SHEET_H, SHEET_W } from '../sheet.js';
import { type ColorKey, type TabKey, tabPiece, TABS, wornPieces } from '../slots.js';
import { FRAME_H, useCanvasSnapping } from './pixelCanvas.js';
import { HistoryButtons, PhoneDock, RosterPane } from './Roster.js';
import { SaveButton } from './SaveButton.js';
import { Stage, type StageScales } from './Stage.js';
import {
  EDITOR_TOOL_KEYS,
  type EditorState,
  type PhoneMode,
  type StatusKind,
  type Studio,
  StudioContext,
} from './studio.js';
import { Wardrobe } from './Wardrobe.js';

interface CharactersViewProps {
  phone: boolean;
  onClose: () => void;
}

function useStatus() {
  const [message, setMessage] = useState<{ text: string; kind: StatusKind } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = useCallback((text: string, kind: StatusKind = '') => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(text ? { text, kind } : null);
    if (text)
      timer.current = setTimeout(
        () => setMessage(null),
        kind === 'err' ? CHARACTERS_STATUS_MS.err : CHARACTERS_STATUS_MS.ok,
      );
  }, []);
  // a toast also clears on the next press anywhere
  useEffect(() => {
    if (!message) return;
    const clear = () => setMessage(null);
    const t = setTimeout(() => document.addEventListener('pointerdown', clear, { once: true }), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', clear);
    };
  }, [message]);
  const element = message && (
    <p className={`chv-status chv-status-${message.kind || 'info'}`} role="status">
      {message.text}
    </p>
  );
  return { status, element };
}

/** Keys typed into a text field are the field's (a slider's arrows and Escape are ours). */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  return target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range';
}

export function CharactersView({ phone, onClose }: CharactersViewProps) {
  const store = useCast();
  // the view shows and edits the draft (the saved list until the first change)
  const cast = useMemo(() => ({ ...store, profiles: store.draft ?? store.profiles }), [store]);
  const dpr = useDevicePixelRatio();
  const root = useRef<HTMLDivElement | null>(null);
  const [rootBoxRef, rootBox] = useBoxSize<HTMLDivElement>();
  const rootRef = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      rootBoxRef(el);
    },
    [rootBoxRef],
  );
  const [tab, setTab] = useState<TabKey>('body');
  const [pickerOpen, setPickerOpen] = useState<ColorKey | null>(null);
  const [editor, setEditorState] = useState<EditorState | null>(null);
  const [phoneMode, setPhoneModeState] = useState<PhoneMode>('wardrobe');
  const { status, element: statusElement } = useStatus();

  // Undo steps follow presses in the view: a press starts one, everything until its
  // release joins it (a drag, a stroke).
  useEffect(() => {
    const el = root.current;
    const press = () => castStore.beginStep();
    const release = () => castStore.endStep();
    el?.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    return () => {
      el?.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      castStore.endStep();
    };
  }, []);
  useCanvasSnapping(root, dpr);

  const profile = cast.profiles[cast.current];

  // Closing keeps nothing unsaved by accident: with changes, it asks first.
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = useCallback(() => {
    if (castStore.getState().dirty) {
      setConfirmClose(true);
      return;
    }
    castStore.discard();
    onClose();
  }, [onClose]);
  const save = useCallback(() => castStore.save(), []);
  const renderer = cast.renderer;

  const setPhoneMode = useCallback((mode: PhoneMode) => {
    setPhoneModeState(mode);
    root.current?.scrollTo(0, 0);
  }, []);
  const openEditor = useCallback(
    (frame: number, pix?: string) => {
      if (!profile || !renderer) return;
      const worn = wornPieces(renderer.wardrobe, profile);
      const wanted = tabPiece(
        TABS.find((t) => t.key === tab)!,
        profile,
      );
      const piece = pix ?? (worn.find((p) => p.pix === wanted) ?? worn[0])?.pix ?? 'body';
      setEditorState({ pix: piece, frame, tool: 'pencil', color: null, fade: false, front: false });
      if (phone) setPhoneMode('tile');
    },
    [profile, renderer, tab, phone, setPhoneMode],
  );
  const closeEditor = useCallback(() => {
    setEditorState(null);
    if (phone) {
      setPhoneModeState((mode) => (mode === 'tile' ? 'sheet' : mode));
      root.current?.scrollTo(0, 0);
    }
  }, [phone]);
  const setEditor = useCallback(
    (patch: Partial<EditorState>) => setEditorState((ed) => (ed ? { ...ed, ...patch } : ed)),
    [],
  );
  const stepFrame = useCallback(
    (d: number) =>
      setEditorState((ed) =>
        ed ? { ...ed, frame: (ed.frame + d + FRAME_COUNT) % FRAME_COUNT } : ed,
      ),
    [],
  );
  const undo = useCallback(() => {
    const frame = castStore.undo();
    if (frame !== null) setEditor({ frame });
  }, [setEditor]);
  const redo = useCallback(() => {
    const frame = castStore.redo();
    if (frame !== null) setEditor({ frame });
  }, [setEditor]);

  const studio: Studio | null = useMemo(() => {
    if (!renderer || !profile) return null;
    return {
      renderer,
      cast,
      profile,
      dpr,
      phone,
      phoneMode,
      setPhoneMode,
      tab,
      setTab,
      pickerOpen,
      setPickerOpen,
      editor,
      openEditor,
      setEditor,
      stepFrame,
      closeEditor,
      edit: (change) => castStore.update(change, editor?.frame ?? null),
      undo,
      redo,
      status,
      save,
      close: requestClose,
    };
  }, [
    renderer,
    cast,
    profile,
    dpr,
    phone,
    phoneMode,
    setPhoneMode,
    tab,
    pickerOpen,
    editor,
    openEditor,
    setEditor,
    stepFrame,
    closeEditor,
    undo,
    redo,
    status,
    save,
    requestClose,
  ]);

  // One keymap for the view: ⌘S saves, ⌘Z / ⇧⌘Z / ⌘Y undo and redo; Escape closes the pixel
  // editor, then the view; with the editor open, B/P E R I pick tools and , . ← → step
  // frames. Keys typed into a text field are left to it.
  const latest = {
    editor,
    closeEditor,
    onClose: requestClose,
    undo,
    redo,
    setEditor,
    stepFrame,
    save,
  };
  const keys = useRef(latest);
  keys.current = latest;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      const k = keys.current;
      const key = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) {
        if (key === 's') {
          e.preventDefault();
          k.save();
          return;
        }
        if (key !== 'z' && key !== 'y') return;
        e.preventDefault();
        if (key === 'y' || e.shiftKey) k.redo();
        else k.undo();
      } else if (key === 'escape') {
        e.preventDefault();
        if (k.editor) k.closeEditor();
        else k.onClose();
      } else if (!k.editor) {
        return;
      } else if (EDITOR_TOOL_KEYS[key]) {
        k.setEditor({ tool: EDITOR_TOOL_KEYS[key] });
      } else if (key === ',' || key === 'arrowleft') {
        k.stepFrame(-1);
      } else if (key === '.' || key === 'arrowright') {
        k.stepFrame(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const desk = useDeskScales(rootBox, phone, dpr, !!studio);
  const scales: StageScales = phone
    ? { hero: CHARACTERS_PHONE_SCALES.hero, turn: CHARACTERS_PHONE_SCALES.turn, sheet: null }
    : desk.scales;

  return (
    <div
      ref={rootRef}
      className={phone ? `chv-root chv-phone chv-mode-${phoneMode}` : 'chv-root chv-desk'}
      style={{ zIndex: CHARACTERS_VIEW_Z_INDEX }}
    >
      {!studio ? (
        <p className="chv-loading">Loading characters…</p>
      ) : (
        <StudioContext.Provider value={studio}>
          {phone ? (
            <>
              <Stage scales={scales} />
              <Wardrobe />
              <SaveButton />
              <PhoneDock />
            </>
          ) : (
            <>
              <div className="chv-backdrop bg-black/50" onClick={requestClose} />
              <div className="chv-panel" ref={desk.panel}>
                <header className="chv-head">
                  <div className="chv-hist" role="group" aria-label="History">
                    <HistoryButtons />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="chv-close"
                    aria-label="Close characters"
                    onClick={requestClose}
                  >
                    <PixelIcon name="close" />
                  </Button>
                </header>
                <RosterPane />
                <Stage scales={scales} ref={desk.stage} />
                <Wardrobe />
                <footer className="chv-foot">
                  <SaveButton />
                </footer>
              </div>
            </>
          )}
          {statusElement}
        </StudioContext.Provider>
      )}
      <Modal
        isOpen={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Unsaved changes"
        zIndex={CHARACTERS_VIEW_Z_INDEX + 1}
      >
        <div className="flex flex-col gap-8 px-10 py-4">
          <p className="text-base m-0">
            Your changes to the characters aren't saved. Save them before closing?
          </p>
          <div className="flex gap-4 justify-end flex-wrap">
            <Button variant="default" onClick={() => setConfirmClose(false)}>
              Keep editing
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setConfirmClose(false);
                castStore.discard();
                onClose();
              }}
            >
              Discard
            </Button>
            <Button
              variant="accent"
              onClick={() => {
                setConfirmClose(false);
                castStore.save();
                castStore.discard();
                onClose();
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Height of the scaled parts of the stage at sheet scale `s`: the big figure and the sheet. */
const scaledStageHeight = (s: number) => FRAME_H * CHARACTERS_HERO_PER_SHEET * s + SHEET_H * s;

/**
 * Desktop preview sizes: the biggest sheet scale whose stage column (and so the three
 * panes, as tall as it) fits the view's box under the header, and leaves the wardrobe
 * CHARACTERS_MIN_WARDROBE_W wide. The big figure is CHARACTERS_HERO_PER_SHEET times the
 * sheet (less, down to CHARACTERS_HERO_MIN_SCALE, when even the smallest sheet doesn't
 * leave room for it), the turn figures match the sheet. The stage's unscaled parts (bars,
 * labels, padding) are measured, not assumed: whatever the stage is beyond its canvases.
 */
const LARGEST: { hero: number; sheet: number } = {
  hero: CHARACTERS_SHEET_SCALE.max * CHARACTERS_HERO_PER_SHEET,
  sheet: CHARACTERS_SHEET_SCALE.max,
};

function useDeskScales(rootBox: BoxSize | null, phone: boolean, dpr: number, ready: boolean) {
  const panel = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLElement>(null);
  const [sizes, setSizes] = useState(LARGEST);
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    void document.fonts?.ready.then(() => setFonts((n) => n + 1));
  }, []);

  // A new box (or dpr, or font) starts again from the largest sizes; then each pass,
  // measured at the sizes it renders, may only shrink them. The stage's unscaled parts
  // grow as it narrows (its bar wraps), so the passes settle on the largest that fits.
  // They all run before paint (layout effect), so nothing in between is ever shown.
  const fittedFor = useRef('');
  useLayoutEffect(() => {
    const p = panel.current;
    const st = stage.current;
    if (phone || !ready || !rootBox || !p || !st) return;
    const key = `${rootBox.width}x${rootBox.height}@${dpr}#${fonts}`;
    if (fittedFor.current !== key) {
      fittedFor.current = key;
      if (sizes !== LARGEST) {
        setSizes(LARGEST);
        return;
      }
    }
    const hero = st.querySelector<HTMLCanvasElement>('.chv-hero canvas');
    const sheetCanvas = st.querySelector<HTMLCanvasElement>('.chv-sheet canvas');
    if (!hero || !sheetCanvas) return;
    const pr = p.getBoundingClientRect();
    const sr = st.getBoundingClientRect();
    const colGap = parseFloat(getComputedStyle(p).columnGap) || 0;
    const rowGap = parseFloat(getComputedStyle(p).rowGap) || 0;
    const foot = p.querySelector<HTMLElement>('.chv-foot');
    // room for the stage: between the header and the footer, and beside the roster leaving
    // the wardrobe its minimum
    const roomH = rootBox.height - (sr.top - pr.top) - (foot ? foot.offsetHeight + rowGap : 0);
    const roomW = pr.right - sr.left - colGap - CHARACTERS_MIN_WARDROBE_W;
    const borders = st.offsetHeight - st.clientHeight;
    const fixedH = st.scrollHeight + borders - hero.offsetHeight - sheetCanvas.offsetHeight;
    const fixedW = st.offsetWidth - sheetCanvas.offsetWidth;
    // whole device pixels per sprite pixel, rounding down (or up, for a minimum)
    const down = (v: number) => Math.floor(v * dpr) / dpr;
    const up = (v: number) => Math.ceil(v * dpr) / dpr;
    const fit = down(Math.min((roomW - fixedW) / SHEET_W, (roomH - fixedH) / scaledStageHeight(1)));
    const sheet = Math.max(up(CHARACTERS_SHEET_SCALE.min), Math.min(sizes.sheet, fit));
    // the big figure: its share of the sheet, smaller when even the smallest sheet leaves less room
    const heroRoom = down((roomH - fixedH - SHEET_H * sheet) / FRAME_H);
    const heroScale = Math.max(
      up(CHARACTERS_HERO_MIN_SCALE),
      Math.min(down(sheet * CHARACTERS_HERO_PER_SHEET), heroRoom),
    );
    if (sheet < sizes.sheet || (sheet === sizes.sheet && heroScale < sizes.hero))
      setSizes({ hero: heroScale, sheet });
  }, [rootBox, phone, dpr, ready, fonts, sizes]);

  const scales: StageScales = { hero: sizes.hero, turn: sizes.sheet, sheet: sizes.sheet };
  return { panel, stage, scales };
}
