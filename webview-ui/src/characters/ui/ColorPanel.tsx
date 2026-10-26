/**
 * One colour of the character (skin, hair, a shirt, ...): its swatches, and behind the
 * rainbow circle a Photoshop-style picker (saturation x brightness square, hue bar,
 * contrast slider) with the colour's hex as worn.
 */

import { useLayoutEffect, useRef } from 'react';

import {
  type CharacterColor,
  DEFAULT_EYE_ROWS,
  EYE_ROWS,
} from '../../../../core/src/characterProfiles.js';
import { Checkbox } from '../../components/ui/Checkbox.js';
import { PickArea } from '../../components/ui/PickArea.js';
import { paintPickCanvas } from '../../components/ui/pickCanvas.js';
import { PixelInputText } from '../../components/ui/PixelInputText.js';
import { PixelText } from '../../components/ui/PixelText.js';
import { CHARACTER_HEX_INSET_PX } from '../../constants.js';
import { SWATCHES } from '../art/artColors.js';
import { hsl01ToRgb, isAsDrawn, toColorize, wrapHue, ZERO_COLOR } from '../color.js';
import { offeredParts } from '../items.js';
import { setColor, setPart } from '../profiles.js';
import { ACCESSORIES, colorArt, type ColorKey, type ColorPicker } from '../slots.js';
import { useStudio } from './studio.js';

type Channel = 'h' | 's' | 'b' | 'c';
const range = (k: Channel, cv: CharacterColor): [number, number] =>
  k === 'h'
    ? cv.colorize
      ? [0, 360]
      : [-180, 180]
    : k === 's' && cv.colorize
      ? [0, 100]
      : [-100, 100];
const fraction = (k: Channel, cv: CharacterColor, value: number) => {
  const [min, max] = range(k, cv);
  return (value - min) / (max - min);
};
const valueAt = (k: Channel, cv: CharacterColor, f: number) => {
  const [min, max] = range(k, cv);
  return Math.round(min + Math.max(0, Math.min(1, f)) * (max - min));
};
const sameColor = (a: CharacterColor | undefined, b: CharacterColor) =>
  !!a &&
  !a.palette &&
  a.h === b.h &&
  a.s === b.s &&
  a.b === b.b &&
  a.c === b.c &&
  !!a.colorize === !!b.colorize;

/** '#a1b2c3', 'a1b2c3' or 'abc' as '#a1b2c3'; null for anything else. */
function parseHex(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return `#${digits.toLowerCase()}`;
}

const SQUARE_PX = 40;
const HUE_PX = 64;

function Picker({
  picker,
  value,
  gray,
}: {
  picker: ColorPicker;
  value: CharacterColor;
  gray: boolean;
}) {
  const { renderer, profile, edit } = useStudio();
  const square = useRef<HTMLCanvasElement>(null);
  const hueBar = useRef<HTMLCanvasElement>(null);
  const live = useRef(value);
  live.current = value;
  const art = colorArt(profile, picker.key);
  const hex = renderer.wayHex(art, value) ?? '';

  const write = (patch: Partial<CharacterColor>) =>
    edit((p) => {
      let next: CharacterColor = { ...live.current, ...patch };
      if (gray && !next.colorize) next = { ...toColorize(next), ...patch, colorize: true };
      setColor(p, picker.key, next);
    });
  const nudge = (k: Channel, d: number) => {
    const [min, max] = range(k, live.current);
    write({ [k]: Math.max(min, Math.min(max, live.current[k] + d)) });
  };

  // the square: what the part's middle tone becomes at each saturation (across) and brightness (up)
  useLayoutEffect(() => {
    const hue = wrapHue(value.h) / 360;
    paintPickCanvas(square.current, (fx, fy) => {
      const sv = valueAt('s', value, fx);
      const bv = valueAt('b', value, 1 - fy);
      const s = value.colorize ? sv / 100 : (sv + 100) / 200;
      return hsl01ToRgb(hue, s, Math.max(0, Math.min(1, 0.5 + bv / 200)));
    });
  }, [value]);

  // the hue bar: every hue of the current mode, top to bottom
  useLayoutEffect(() => {
    paintPickCanvas(hueBar.current, (_fx, fy) => {
      const h = valueAt('h', value, fy);
      return hsl01ToRgb(wrapHue(h) / 360, 1, 0.5);
    });
  }, [value.colorize]); // eslint-disable-line react-hooks/exhaustive-deps

  // a typed hex puts the part's main tone on that colour, keeping the contrast as it is
  const typeHex = (input: HTMLInputElement) => {
    const typed = parseHex(input.value);
    if (!typed) input.value = hex;
    else if (typed !== hex)
      edit((p) => setColor(p, picker.key, renderer.hexValue(art, typed, live.current.c)));
  };

  const toggleColorize = () =>
    edit((p) => {
      const now = live.current;
      const next: CharacterColor = now.colorize ? { ...now, colorize: undefined } : toColorize(now);
      if (!next.colorize && next.h > 180) next.h -= 360;
      setColor(p, picker.key, next);
    });

  const id = `chv-${picker.key}`;
  return (
    <div className="chv-hsbc">
      <div className="chv-pick">
        <PickArea
          className="chv-pick-sq"
          id={`${id}-sb`}
          tabIndex={0}
          role="slider"
          aria-label={`${picker.label} saturation and brightness`}
          aria-valuetext={`saturation ${value.s}, brightness ${value.b}`}
          onPick={(fx, fy) =>
            write({ s: valueAt('s', live.current, fx), b: valueAt('b', live.current, 1 - fy) })
          }
          onKeyDown={(e) => {
            const d = e.shiftKey ? 10 : 1;
            const move = (
              {
                ArrowLeft: ['s', -d],
                ArrowRight: ['s', d],
                ArrowUp: ['b', d],
                ArrowDown: ['b', -d],
              } as const
            )[e.key as 'ArrowLeft'];
            if (!move) return;
            e.preventDefault();
            nudge(move[0], move[1]);
          }}
        >
          <canvas ref={square} width={SQUARE_PX} height={SQUARE_PX} />
          <span
            className="chv-pick-dot"
            style={{
              left: `${fraction('s', value, value.s) * 100}%`,
              top: `${(1 - fraction('b', value, value.b)) * 100}%`,
            }}
          />
        </PickArea>
        <PickArea
          className="chv-pick-hue"
          id={`${id}-h`}
          tabIndex={0}
          role="slider"
          aria-label={`${picker.label} hue`}
          aria-valuenow={value.h}
          onPick={(_fx, fy) => write({ h: valueAt('h', live.current, fy) })}
          onKeyDown={(e) => {
            const d = e.shiftKey ? 10 : 1;
            const move = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
            if (!move) return;
            e.preventDefault();
            nudge('h', move);
          }}
        >
          <canvas ref={hueBar} width={1} height={HUE_PX} />
          <span
            className="chv-pick-mark"
            style={{ top: `${fraction('h', value, value.h) * 100}%` }}
          />
        </PickArea>
      </div>
      <div className="chv-pick-read">
        <span className="chv-pick-chip" style={{ background: hex }} />
        <PixelInputText text={hex.toUpperCase()} insetPx={CHARACTER_HEX_INSET_PX}>
          <input
            // remounted whenever the worn colour changes, so it always starts from it
            key={hex}
            className="chv-pick-hex"
            aria-label={`${picker.label} hex`}
            defaultValue={hex}
            maxLength={7}
            spellCheck={false}
            onBlur={(e) => typeHex(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') typeHex(e.currentTarget);
              else if (e.key === 'Escape') e.currentTarget.value = hex;
            }}
          />
        </PixelInputText>
        {!gray && (
          // parts drawn in colour can shift their colours or colorize them
          <Checkbox
            variant="inline"
            className="chv-check"
            checked={!!value.colorize}
            title="Colorize sets an absolute hue and saturation instead of shifting the original colours"
            onChange={toggleColorize}
            label="Colorize"
          />
        )}
      </div>
      <label className="chv-c-lab" htmlFor={`${id}-c`}>
        Contrast
      </label>
      <output className="chv-c-out" htmlFor={`${id}-c`}>
        <PixelText text={String(value.c)} />
      </output>
      <input
        className="chv-c-in"
        id={`${id}-c`}
        type="range"
        min={-100}
        max={100}
        step={1}
        value={value.c}
        style={{ '--fill': `${fraction('c', value, value.c) * 100}%` } as React.CSSProperties}
        onChange={(e) => write({ c: +e.target.value })}
      />
    </div>
  );
}

/** A row of labelled choices under the swatches (accessory styles, eye colour rows). */
function ChoiceRow(props: {
  label: string;
  options: { id: string; label: string; title?: string; pressed: boolean; onClick: () => void }[];
}) {
  return (
    <div className="chv-swatches">
      <span className="chv-choice-label">{props.label}</span>
      {props.options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="chv-sw chv-sw-text"
          aria-pressed={o.pressed}
          title={o.title}
          onClick={o.onClick}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorPanel({ picker }: { picker: ColorPicker }) {
  const { renderer, profile, edit, pickerOpen, setPickerOpen, cast } = useStudio();
  const key: ColorKey = picker.key;
  // gray clothes and hair nobody has coloured wear their default: that square reads as picked
  const fallback = profile.colors?.[key] ? null : renderer.defaultColor(profile, key);
  const value = profile.colors?.[key] ?? fallback ?? undefined;
  const art = colorArt(profile, key);
  const palette = renderer.paletteFor(art);
  // an untouched beard wears the hair's colour and a tie the outfit's, so no square is "as drawn" for them
  const follows = (key === 'beard' && !!profile.hair) || (key === 'tie' && !!profile.colors?.full);
  const asDrawnPressed = (value ? isAsDrawn(value) : false) || (!value && !follows);
  const choose = (cv: CharacterColor) => edit((p) => setColor(p, key, cv));

  // `value` is computed on click: fitting a swatch to the part scans its pixels
  const squares: {
    label: string;
    hex: string | null;
    value: () => CharacterColor;
    pressed: boolean;
  }[] = [];
  if (palette) {
    palette.squares.forEach((square, i) => {
      const cv = palette.row[i];
      const pressed = cv.palette
        ? !!value && value.palette === cv.palette && isAsDrawn({ ...value, palette: undefined })
        : isAsDrawn(cv)
          ? asDrawnPressed
          : sameColor(value, cv);
      squares.push({ label: square.label, hex: square.hex, value: () => cv, pressed });
    });
  } else {
    // eyes, lashes and underwear: the art as drawn, then swatches fitted to the part's shading
    squares.push({
      label: 'As drawn',
      hex: renderer.wayHex(art, ZERO_COLOR),
      value: () => ZERO_COLOR,
      pressed: asDrawnPressed,
    });
    const swatches: readonly string[] =
      key === 'eyes' || key === 'lashes' ? SWATCHES[key] : SWATCHES.default;
    for (const hex of swatches) {
      squares.push({
        label: hex,
        hex,
        value: () => renderer.swatchValue(art, hex, key),
        pressed: false,
      });
    }
  }

  const gray = renderer.isNeutral(art);
  let shown: CharacterColor = value ??
    renderer.colorOf(profile, key) ?? { ...ZERO_COLOR, colorize: gray || undefined };
  if (gray && !shown.colorize && !shown.palette) shown = toColorize(shown);
  const styled = ACCESSORIES.find((a) => a.key === key);
  const styles = styled?.styles;

  return (
    <div className="chv-colors">
      <h2>{picker.label}</h2>
      <div className="chv-swatches">
        <button
          type="button"
          className="chv-sw chv-wheel"
          title="Custom colour"
          aria-label={`${picker.label}: custom colour`}
          aria-pressed={pickerOpen === key}
          onClick={() => setPickerOpen(pickerOpen === key ? null : key)}
        />
        {squares.map((sq) => (
          <button
            key={sq.label}
            type="button"
            className="chv-sw"
            style={sq.hex ? { background: sq.hex } : undefined}
            title={sq.label}
            aria-label={`${picker.label} ${sq.label}`}
            aria-pressed={sq.pressed}
            onClick={() => choose(sq.value())}
          />
        ))}
      </div>
      {styled && styles && profile[styled.key] && (
        <ChoiceRow
          label={styles}
          options={offeredParts(renderer, cast, styled.key).map((part) => ({
            id: part.id,
            label: part.label,
            pressed: profile[styled.key] === part.id,
            onClick: () => edit((p) => setPart(p, styled.key, part.id)),
          }))}
        />
      )}
      {key === 'eyes' && (
        // which of each eye's two pixels takes the colour (the other is black pupil)
        <ChoiceRow
          label="Colour on"
          options={EYE_ROWS.map((rows) => ({
            id: rows,
            label: rows[0].toUpperCase() + rows.slice(1),
            title: `Colour the ${rows === 'both' ? 'whole eye' : `${rows} pixel of each eye`} in every frame`,
            pressed: (profile.eyeRows ?? DEFAULT_EYE_ROWS) === rows,
            onClick: () =>
              edit((p) => {
                p.eyeRows = rows === DEFAULT_EYE_ROWS ? undefined : rows;
              }),
          }))}
        />
      )}
      {pickerOpen === key && <Picker picker={picker} value={shown} gray={gray} />}
    </div>
  );
}
