/**
 * The roster: every character, the one being edited highlighted. Desktop: a pane of
 * cards with the actions under them. Phones: a dock pinned to the bottom with small
 * cards, New, Edit/Done and a More sheet.
 */

import { useEffect, useRef, useState } from 'react';

import { PixelIcon } from '../../components/ui/PixelIcon.js';
import { castStore } from '../castStore.js';
import { ArmedButton } from './ArmedButton.js';
import { type CastActions, useCastActions } from './castActions.js';
import type { SpriteView } from './pixelCanvas.js';
import { SpriteCanvas } from './SpriteCanvas.js';
import { useStudio } from './studio.js';
import { ViewButton } from './ViewButton.js';

const FRONT: SpriteView = { kind: 'frame', facing: 'down', frame: 0 };

/** The roster's actions on the cast, as both rosters list them. */
const ROSTER_ACTIONS: { label: string; title?: string; run: (a: CastActions) => void }[] = [
  { label: 'Duplicate', run: (a) => a.duplicate() },
  {
    label: 'New random',
    title: 'Add a new character with random clothes, hair and colours',
    run: (a) => a.addRandom(),
  },
  {
    label: 'Randomize',
    title: 'Re-roll the character you are editing',
    run: (a) => a.randomizeCurrent(),
  },
  {
    label: 'Save PNG',
    title: 'Save the character you are editing as a single sprite sheet',
    run: (a) => void a.savePng(),
  },
  {
    label: 'Save config',
    title:
      "Save this character's settings (parts, colours, pixel edits) as a .json file you can load back later",
    run: (a) => void a.saveConfig(),
  },
  {
    label: 'Load config',
    title: 'Add characters from saved .json config files',
    run: (a) => a.loadConfigs(),
  },
];

/** Undo and Redo, for the desktop header and the phone's More sheet. */
export function HistoryButtons() {
  const { cast, undo, redo } = useStudio();
  return (
    <>
      <ViewButton title="Undo (⌘Z)" icon="undo" disabled={!cast.canUndo} onClick={undo}>
        Undo
      </ViewButton>
      <ViewButton title="Redo (⇧⌘Z)" icon="redo" disabled={!cast.canRedo} onClick={redo}>
        Redo
      </ViewButton>
    </>
  );
}

export function RosterPane() {
  const { renderer, cast, dpr } = useStudio();
  const actions = useCastActions();
  return (
    <section className="chv-box chv-roster" aria-label="Roster">
      <h2>Roster</h2>
      <div className="chv-rail">
        {cast.profiles.map((p, i) => (
          <div key={i} className="chv-card" aria-current={i === cast.current}>
            <button
              type="button"
              className="chv-card-pick"
              aria-label={`Edit ${p.name || `character ${i}`}`}
              onClick={() => castStore.select(i)}
            >
              <SpriteCanvas sheet={renderer.sheet(p)} view={FRONT} scale={2} dpr={dpr} />
              <span className="chv-card-file">char_{i}</span>
            </button>
            <input
              value={p.name ?? ''}
              placeholder="Name"
              aria-label={`Name for char_${i}`}
              onChange={(e) => {
                const name = e.target.value;
                castStore.updateAt(i, (draft) => {
                  draft.name = name;
                });
              }}
            />
            {cast.profiles.length > 1 && (
              <button
                type="button"
                className="chv-card-x"
                aria-label={`Remove char_${i}`}
                onClick={() => actions.remove(i)}
              >
                <PixelIcon name="close" scale={1} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="chv-card chv-card-add" onClick={actions.add}>
          + New character
        </button>
      </div>
      <div className="chv-roster-actions">
        {ROSTER_ACTIONS.map((action) => (
          <ViewButton key={action.label} title={action.title} onClick={() => action.run(actions)}>
            {action.label}
          </ViewButton>
        ))}
        <ViewButton
          className="chv-roster-zip"
          title="Save every character's sheet and config in one .zip"
          onClick={() => void actions.saveRoster()}
        >
          Save roster .zip
        </ViewButton>
      </div>
    </section>
  );
}

/** The phone's More sheet: the current character's name and every roster action. */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const { profile, cast } = useStudio();
  const actions = useCastActions();
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div className="chv-box chv-more" role="dialog" aria-label="Character actions">
      <label className="chv-more-name">
        <span>Name</span>
        <input
          value={profile.name ?? ''}
          placeholder="Name"
          onChange={(e) => {
            const name = e.target.value;
            castStore.update((draft) => {
              draft.name = name;
            });
          }}
        />
      </label>
      <div className="chv-more-grid">
        <HistoryButtons />
        {ROSTER_ACTIONS.map((action) => (
          <ViewButton key={action.label} onClick={run(() => action.run(actions))}>
            {action.label}
          </ViewButton>
        ))}
        <ArmedButton
          as={ViewButton}
          label="Remove"
          confirmLabel="Tap to confirm"
          disabled={cast.profiles.length < 2}
          onConfirm={run(() => actions.remove(cast.current))}
        />
        <ViewButton primary onClick={run(() => void actions.saveRoster())}>
          Save roster .zip
        </ViewButton>
      </div>
    </div>
  );
}

export function PhoneDock() {
  const { renderer, cast, dpr, phoneMode, setPhoneMode, editor, closeEditor } = useStudio();
  const actions = useCastActions();
  const [moreOpen, setMoreOpen] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);

  // keep the current card in view
  const current = cast.current;
  useEffect(() => {
    const card = rail.current?.children[current] as HTMLElement | undefined;
    if (!card || !rail.current) return;
    const r = card.getBoundingClientRect();
    const m = rail.current.getBoundingClientRect();
    if (r.left < m.left || r.right > m.right) rail.current.scrollLeft += r.left - m.left - 8;
  }, [current]);

  // the page leaves room for the dock (and the More sheet sits above it)
  useEffect(() => {
    const el = dock.current;
    if (!el) return;
    const sync = () =>
      el.closest<HTMLElement>('.chv-root')?.style.setProperty('--dock-h', `${el.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // a press outside the More sheet closes it
  useEffect(() => {
    if (!moreOpen) return;
    const onPress = (e: PointerEvent) => {
      if (!(e.target as Element).closest('.chv-more, .chv-dock-more')) setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPress);
    return () => document.removeEventListener('pointerdown', onPress);
  }, [moreOpen]);

  const editing = phoneMode !== 'wardrobe';
  return (
    <>
      <nav ref={dock} className="chv-dock" aria-label="Roster">
        <div className="chv-dock-rail" ref={rail}>
          {cast.profiles.map((p, i) => (
            <button
              key={i}
              type="button"
              className="chv-mcard"
              aria-current={i === cast.current}
              aria-label={`Edit ${p.name || `char_${i}`}`}
              onClick={() => {
                if (i === cast.current) return;
                castStore.select(i);
                if (editor) closeEditor();
              }}
            >
              <SpriteCanvas sheet={renderer.sheet(p)} view={FRONT} scale={1.5} dpr={dpr} />
              <span>{p.name || `char_${i}`}</span>
            </button>
          ))}
        </div>
        <div className="chv-dock-actions">
          <button
            type="button"
            className="chv-dbtn"
            title="Add a new character"
            onClick={() => {
              if (editor) closeEditor();
              setPhoneMode('wardrobe');
              actions.add();
            }}
          >
            <PixelIcon name="plus" />
            <span>New</span>
          </button>
          <button
            type="button"
            className="chv-dbtn chv-dbtn-primary"
            title="Edit this character's sheet frame by frame"
            onClick={() => {
              setMoreOpen(false);
              if (editor) closeEditor();
              setPhoneMode(editing ? 'wardrobe' : 'sheet');
            }}
          >
            <PixelIcon name={editing ? 'check' : 'pencil'} />
            <span>{editing ? 'Done' : 'Edit'}</span>
          </button>
          <button
            type="button"
            className="chv-dbtn chv-dock-more"
            aria-expanded={moreOpen}
            title="More actions"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <PixelIcon name="more" />
            <span>More</span>
          </button>
        </div>
      </nav>
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </>
  );
}
