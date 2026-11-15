/**
 * The roster: every character, the one being edited highlighted. Desktop: a pane of
 * cards with the actions under them. Phones: a dock pinned to the bottom with small
 * cards, New, Edit/Done and a More sheet.
 */

import { useEffect, useRef, useState } from 'react';

import { PixelIcon } from '../../components/ui/PixelIcon.js';
import { type MessageKey, useT } from '../../i18n/index.js';
import { castStore } from '../castStore.js';
import { ArmedButton } from './ArmedButton.js';
import { type CastActions, useCastActions } from './castActions.js';
import type { SpriteView } from './pixelCanvas.js';
import { SpriteCanvas } from './SpriteCanvas.js';
import { useStudio } from './studio.js';
import { ViewButton } from './ViewButton.js';

const FRONT: SpriteView = { kind: 'frame', facing: 'down', frame: 0 };

/** The roster's actions on the cast, as both rosters list them. */
const ROSTER_ACTIONS: { label: MessageKey; title?: MessageKey; run: (a: CastActions) => void }[] = [
  { label: 'characters.duplicate', run: (a) => a.duplicate() },
  {
    label: 'characters.newRandom',
    title: 'characters.newRandomTitle',
    run: (a) => a.addRandom(),
  },
  {
    label: 'characters.randomize',
    title: 'characters.randomizeTitle',
    run: (a) => a.randomizeCurrent(),
  },
  {
    label: 'characters.savePng',
    title: 'characters.savePngTitle',
    run: (a) => void a.savePng(),
  },
  {
    label: 'characters.saveConfig',
    title: 'characters.saveConfigTitle',
    run: (a) => void a.saveConfig(),
  },
  {
    label: 'characters.loadConfig',
    title: 'characters.loadConfigTitle',
    run: (a) => a.loadConfigs(),
  },
];

/** Undo and Redo, for the desktop header and the phone's More sheet. */
export function HistoryButtons() {
  const { cast, undo, redo } = useStudio();
  const t = useT();
  return (
    <>
      <ViewButton
        title={t('characters.undoTitle')}
        icon="undo"
        disabled={!cast.canUndo}
        onClick={undo}
      >
        {t('common.undo')}
      </ViewButton>
      <ViewButton
        title={t('characters.redoTitle')}
        icon="redo"
        disabled={!cast.canRedo}
        onClick={redo}
      >
        {t('common.redo')}
      </ViewButton>
    </>
  );
}

export function RosterPane() {
  const { renderer, cast, dpr } = useStudio();
  const t = useT();
  const actions = useCastActions();
  return (
    <section className="chv-box chv-roster" aria-label={t('characters.roster')}>
      <h2>{t('characters.roster')}</h2>
      <div className="chv-rail">
        {cast.profiles.map((p, i) => (
          <div key={i} className="chv-card" aria-current={i === cast.current}>
            <button
              type="button"
              className="chv-card-pick"
              aria-label={t('characters.editName', {
                name: p.name || t('characters.characterN', { n: i }),
              })}
              onClick={() => castStore.select(i)}
            >
              <SpriteCanvas sheet={renderer.sheet(p)} view={FRONT} scale={2} dpr={dpr} />
              <span className="chv-card-file">char_{i}</span>
            </button>
            <input
              value={p.name ?? ''}
              placeholder={t('characters.name')}
              aria-label={t('characters.nameFor', { file: `char_${i}` })}
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
                aria-label={t('characters.removeChar', { file: `char_${i}` })}
                onClick={() => actions.remove(i)}
              >
                <PixelIcon name="close" scale={1} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="chv-card chv-card-add" onClick={actions.add}>
          {t('characters.newCharacter')}
        </button>
      </div>
      <div className="chv-roster-actions">
        {ROSTER_ACTIONS.map((action) => (
          <ViewButton
            key={action.label}
            title={action.title && t(action.title)}
            onClick={() => action.run(actions)}
          >
            {t(action.label)}
          </ViewButton>
        ))}
        <ViewButton
          className="chv-roster-zip"
          title={t('characters.saveRosterTitle')}
          onClick={() => void actions.saveRoster()}
        >
          {t('characters.saveRoster')}
        </ViewButton>
      </div>
    </section>
  );
}

/** The phone's More sheet: the current character's name and every roster action. */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const { profile, cast } = useStudio();
  const t = useT();
  const actions = useCastActions();
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div className="chv-box chv-more" role="dialog" aria-label={t('characters.characterActions')}>
      <label className="chv-more-name">
        <span>{t('characters.name')}</span>
        <input
          value={profile.name ?? ''}
          placeholder={t('characters.name')}
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
            {t(action.label)}
          </ViewButton>
        ))}
        <ArmedButton
          as={ViewButton}
          label={t('common.remove')}
          confirmLabel={t('characters.tapToConfirm')}
          disabled={cast.profiles.length < 2}
          onConfirm={run(() => actions.remove(cast.current))}
        />
        <ViewButton primary onClick={run(() => void actions.saveRoster())}>
          {t('characters.saveRoster')}
        </ViewButton>
      </div>
    </div>
  );
}

export function PhoneDock() {
  const { renderer, cast, dpr, phoneMode, setPhoneMode, editor, closeEditor } = useStudio();
  const t = useT();
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
      <nav ref={dock} className="chv-dock" aria-label={t('characters.roster')}>
        <div className="chv-dock-rail" ref={rail}>
          {cast.profiles.map((p, i) => (
            <button
              key={i}
              type="button"
              className="chv-mcard"
              aria-current={i === cast.current}
              aria-label={t('characters.editName', { name: p.name || `char_${i}` })}
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
            title={t('characters.addNew')}
            onClick={() => {
              if (editor) closeEditor();
              setPhoneMode('wardrobe');
              actions.add();
            }}
          >
            <PixelIcon name="plus" />
            <span>{t('characters.new')}</span>
          </button>
          <button
            type="button"
            className="chv-dbtn chv-dbtn-primary"
            title={t('characters.editSheetTitle')}
            onClick={() => {
              setMoreOpen(false);
              if (editor) closeEditor();
              setPhoneMode(editing ? 'wardrobe' : 'sheet');
            }}
          >
            <PixelIcon name={editing ? 'check' : 'pencil'} />
            <span>{editing ? t('common.done') : t('common.edit')}</span>
          </button>
          <button
            type="button"
            className="chv-dbtn chv-dock-more"
            aria-expanded={moreOpen}
            title={t('characters.moreActions')}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <PixelIcon name="more" />
            <span>{t('characters.more')}</span>
          </button>
        </div>
      </nav>
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </>
  );
}
