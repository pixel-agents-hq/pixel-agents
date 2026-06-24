import type { CSSProperties } from 'react';

import { VisualColorPicker } from '../VisualColorPicker.js';
import { Button } from './Button.js';
import type { ColorValue } from './types.js';

function ColorSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className="flex items-center gap-8">
      <span className="text-sm text-text-muted w-64 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="pixel-range flex-1 min-w-0"
        style={{ '--range-fill': `${pct}%` } as CSSProperties}
      />
      <span className="text-sm text-text w-44 text-right shrink-0 tabular-nums">{value}</span>
    </div>
  );
}

interface ColorPickerProps {
  value: ColorValue;
  onChange: (color: ColorValue) => void;
  /** Force colorize-style H/S ranges (H: 0–360, S: 0–100) */
  colorize?: boolean;
  /** Show a colorize checkbox that lets the user toggle the mode */
  showColorizeToggle?: boolean;
  /** When provided, renders a Reset button below the sliders that calls this handler. */
  onReset?: () => void;
}

export function ColorPicker({
  value,
  onChange,
  colorize,
  showColorizeToggle,
  onReset,
}: ColorPickerProps) {
  const handleChange = (key: keyof ColorValue, v: number) => {
    onChange({ ...value, [key]: v });
  };

  const isColorize = colorize || !!value.colorize;

  return (
    <div className="flex flex-col py-8 px-10 bg-bg-dark border-2 border-border rounded-none">
      <ColorSlider
        label="Hue"
        value={value.h}
        min={isColorize ? 0 : -180}
        max={isColorize ? 360 : 180}
        onChange={(v) => handleChange('h', v)}
      />
      <ColorSlider
        label="Saturation"
        value={value.s}
        min={isColorize ? 0 : -100}
        max={100}
        onChange={(v) => handleChange('s', v)}
      />
      <ColorSlider
        label="Brightness"
        value={value.b}
        min={-100}
        max={100}
        onChange={(v) => handleChange('b', v)}
      />
      <ColorSlider
        label="Contrast"
        value={value.c}
        min={-100}
        max={100}
        onChange={(v) => handleChange('c', v)}
      />

      {/* Colorize row: a toggle, then (when on) the carpet-style swatch + hex
          control that opens a visual picker on click. */}
      {(showColorizeToggle || onReset) && (
        <div className="flex items-center gap-8 -mt-4">
          {showColorizeToggle && (
            <button
              type="button"
              onClick={() => onChange({ ...value, colorize: !value.colorize || undefined })}
              className="flex items-center gap-8 shrink-0 bg-transparent border-0 p-0 cursor-pointer text-left"
              title="Toggle colorize mode"
            >
              <span className="text-sm text-text-muted w-64 shrink-0">Colorize</span>
              <span
                className={`w-18 h-18 border-2 border-border inline-flex items-center justify-center text-2xs leading-none text-text shrink-0 ${
                  value.colorize ? 'bg-accent' : 'bg-bg'
                }`}
              >
                {value.colorize ? 'x' : ''}
              </span>
            </button>
          )}
          {showColorizeToggle && value.colorize ? (
            <>
              <VisualColorPicker value={value} onChange={onChange} />
              <span className="flex-1" />
            </>
          ) : (
            <span className="flex-1" />
          )}
          {onReset && (
            <Button
              variant="default"
              size="sm"
              onClick={onReset}
              title="Reset to default"
              className="mt-6"
            >
              Reset
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
