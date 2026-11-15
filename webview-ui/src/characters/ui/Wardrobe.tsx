/**
 * The wardrobe: a tab per slot, each with its part options (drawn on the character) and
 * colour panels. The pixel editor takes the pane's place while it is open.
 */

import { useDeferredValue, useLayoutEffect, useRef } from 'react';

import type { CharacterProfile } from '../../../../core/src/characterProfiles.js';
import { useLocale, useT } from '../../i18n/index.js';
import { offeredParts } from '../items.js';
import { partName } from '../labels.js';
import { setPart, setUnderwear, tabSummary } from '../profiles.js';
import {
  ACCESSORIES,
  colorArt,
  EYE_SHAPES,
  eyeShape,
  layerOf,
  type SlotKey,
  TABS,
  underOf,
} from '../slots.js';
import { ColorPanel } from './ColorPanel.js';
import type { SpriteView } from './pixelCanvas.js';
import { PixelEditor } from './PixelEditor.js';
import { SpriteCanvas } from './SpriteCanvas.js';
import { useStudio } from './studio.js';

const THUMB_SCALE = 3;
const FACE_SCALE = 6;
const FRONT: SpriteView = { kind: 'frame', facing: 'down', frame: 0 };

interface OptionCard {
  key: string;
  label: string;
  pressed: boolean;
  /** Put this option on a draft: what a click does, and what the thumbnail shows. */
  wear: (draft: CharacterProfile) => void;
  /** A click that does something else than wearing it (an accessory's toggle). */
  onClick?: () => void;
  none?: boolean;
  title?: string;
}

/** The profile wearing a card's option (wear touches only top-level fields: a shallow copy will do). */
function wearing(p: CharacterProfile, card: OptionCard): CharacterProfile {
  const draft = { ...p };
  card.wear(draft);
  return draft;
}

/** Option cards, each showing the character wearing it. Thumbnails lag a drag a little (deferred). */
function OptionGrid({ cards, face = false }: { cards: OptionCard[]; face?: boolean }) {
  const { renderer, profile, dpr, edit } = useStudio();
  const shown = useDeferredValue(profile);
  return (
    <div className={face ? 'chv-grid chv-eye-shapes' : 'chv-grid'}>
      {cards.map((card) => (
        <button
          key={card.key}
          type="button"
          className={card.none ? 'chv-opt chv-opt-none' : 'chv-opt'}
          aria-pressed={card.pressed}
          title={card.title}
          onClick={card.onClick ?? (() => edit(card.wear))}
        >
          <SpriteCanvas
            sheet={renderer.sheet(wearing(shown, card))}
            view={face ? { kind: 'face' } : FRONT}
            scale={face ? FACE_SCALE : THUMB_SCALE}
            dpr={dpr}
          />
          <span>{card.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A slot's parts: None (and Underwear for Top/Pants) first, then every offered part. */
function SlotOptions({ slot }: { slot: SlotKey }) {
  const { renderer, profile, cast } = useStudio();
  const t = useT();
  const under = underOf(slot);
  const worn = profile[slot];
  const cards: OptionCard[] = [];
  if (under) {
    for (const on of [false, true]) {
      cards.push({
        key: on ? '_under' : '_none',
        label: on ? t('characters.underwear') : t('characters.none'),
        none: !on,
        pressed: !worn && !!profile[under] === on,
        wear: (p) => setUnderwear(p, slot, on),
      });
    }
  } else if (slot !== 'body') {
    cards.push({
      key: '_none',
      label: t('characters.none'),
      none: true,
      pressed: !worn,
      wear: (p) => setPart(p, slot, null),
    });
  }
  for (const part of offeredParts(renderer, cast, slot)) {
    cards.push({
      key: part.id,
      label: partName(part),
      pressed: worn === part.id,
      wear: (p) => setPart(p, slot, part.id),
    });
  }
  return <OptionGrid cards={cards} />;
}

function EyeShapes() {
  const { profile } = useStudio();
  const t = useT();
  const current = eyeShape(profile);
  const cards: OptionCard[] = EYE_SHAPES.map((shape) => ({
    key: shape.id,
    label: t(shape.label),
    title: t(shape.title),
    pressed: current === shape,
    wear: (p) => {
      p.eyeShape = shape.id;
    },
  }));
  return (
    <div className="chv-colors">
      <h2>{t('characters.shape')}</h2>
      <OptionGrid cards={cards} face />
    </div>
  );
}

/** A card per accessory that puts it on or takes it off (styled ones: one card, styles in its colour panel). */
function Accessories() {
  const { renderer, profile, edit, cast } = useStudio();
  const t = useT();
  const cards: OptionCard[] = [];
  for (const acc of ACCESSORIES) {
    const parts = offeredParts(renderer, cast, acc.key);
    const shownParts = acc.styles
      ? [parts.find((p) => p.id === profile[acc.key]) ?? parts[0]]
      : parts;
    for (const part of shownParts) {
      const on = acc.styles ? !!profile[acc.key] : profile[acc.key] === part.id;
      cards.push({
        key: `${acc.key}:${part.id}`,
        label: parts.length > 1 && !acc.styles ? partName(part) : t(acc.label),
        pressed: on,
        wear: (p) => setPart(p, acc.key, part.id),
        onClick: () => edit((p) => setPart(p, acc.key, on ? null : part.id)),
      });
    }
  }
  return <OptionGrid cards={cards} />;
}

function SlotPanel() {
  const { profile, tab, phone, renderer } = useStudio();
  const t = useT();
  const def = TABS.find((d) => d.key === tab)!;
  const under = underOf(tab);
  let options: React.ReactNode = null;
  const panels: React.ReactNode[] = [];
  if (tab === 'acc') {
    options = <Accessories />;
    for (const acc of ACCESSORIES) {
      if (profile[acc.key])
        panels.push(<ColorPanel key={acc.key} picker={{ key: acc.key, label: t(acc.label) }} />);
    }
  } else if (tab === 'eyes') {
    panels.push(<EyeShapes key="shape" />);
    for (const picker of def.pickers)
      panels.push(
        <ColorPanel key={picker.key} picker={{ key: picker.key, label: t(picker.label) }} />,
      );
  } else {
    options = <SlotOptions slot={tab} />;
    if (profile[tab]) {
      for (const picker of def.pickers) {
        const art = colorArt(profile, picker.key);
        if (art && renderer.wardrobe.art.has(art.path))
          panels.push(
            <ColorPanel key={picker.key} picker={{ key: picker.key, label: t(picker.label) }} />,
          );
      }
    } else if (under && profile[under]) {
      panels.push(
        <ColorPanel key={under} picker={{ key: under, label: t('characters.underwearColour') }} />,
      );
    }
    const { inner } = def;
    if (inner) {
      // the slot inside this tab (beards, under the hairstyles): None or one style, then its colour
      const label = t(layerOf(inner).label);
      panels.push(
        <div key={inner} className="chv-colors">
          <h2>{label}</h2>
          <SlotOptions slot={inner} />
        </div>,
      );
      if (profile[inner])
        panels.push(
          <ColorPanel
            key={`${inner}-colour`}
            picker={{ key: inner, label: t('characters.colourOf', { name: label }) }}
          />,
        );
    }
  }
  return (
    <div className="chv-slot">
      {!phone && <h2 className="chv-slot-head">{t(def.label)}</h2>}
      {options}
      {panels.length > 0 && <div className="chv-slot-body">{panels}</div>}
    </div>
  );
}

/** One line of tabs (down the side on desktop), each as wide as the longest slot name. */
function Tabs() {
  const { renderer, profile, tab, setTab, phone } = useStudio();
  const t = useT();
  // the names' widths change with the language: measured again on a switch
  const { locale } = useLocale();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const fit = () => {
      const names = [...el.querySelectorAll('b')];
      const tab = el.querySelector('button');
      if (!names.length || !tab || !el.clientWidth) return;
      const widest = Math.max(...names.map((b) => b.getBoundingClientRect().width));
      // plus the tab's own padding and border
      const cs = getComputedStyle(tab);
      const frame = [cs.paddingLeft, cs.paddingRight, cs.borderLeftWidth, cs.borderRightWidth]
        .map(parseFloat)
        .reduce((a, b) => a + b, 0);
      el.style.setProperty('--tab-w', `${Math.ceil(widest) + frame}px`);
    };
    fit();
    void document.fonts?.ready.then(fit);
  }, [locale]);
  // keep the chosen tab in view
  useLayoutEffect(() => {
    const el = list.current;
    const chosen = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !chosen) return;
    const r = chosen.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    // keep the strip's scroll padding (phones) clear of the chosen tab
    const pad = parseFloat(getComputedStyle(el).scrollPaddingInlineStart) || 0;
    if (r.left < t.left + pad) el.scrollLeft += r.left - t.left - pad;
    else if (r.right > t.right - pad) el.scrollLeft += r.right - t.right + pad;
  }, [tab, phone]);
  return (
    <div className="chv-tabs" role="tablist" ref={list}>
      {TABS.map((def) => (
        <button
          key={def.key}
          type="button"
          role="tab"
          aria-selected={tab === def.key}
          onClick={() => setTab(def.key)}
        >
          <b>{t(def.label)}</b>
          <span>{tabSummary(renderer.wardrobe, profile, def.key)}</span>
        </button>
      ))}
    </div>
  );
}

export function Wardrobe() {
  const { editor } = useStudio();
  const t = useT();
  return (
    <section className="chv-box chv-wardrobe" aria-label={t('characters.wardrobe')}>
      {editor ? (
        <PixelEditor />
      ) : (
        <>
          <Tabs />
          <SlotPanel />
        </>
      )}
    </section>
  );
}
