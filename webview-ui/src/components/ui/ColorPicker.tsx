import type { ColorValue } from "./types.js";

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
  return (
    <div className="flex items-center gap-4">
      <span className="text-sm text-text-muted w-28 text-right shrink-0">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-12 accent-accent"
      />
      <span className="text-sm text-text-muted w-48 text-right shrink-0">
        {value}
      </span>
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
}

export function ColorPicker({
  value,
  onChange,
  colorize,
  showColorizeToggle,
}: ColorPickerProps) {
  const handleChange = (key: keyof ColorValue, v: number) => {
    onChange({ ...value, [key]: v });
  };

  const isColorize = colorize || !!value.colorize;

  return (
    <div className="flex flex-col gap-3 py-4 px-6 bg-bg-dark border-2 border-border rounded-none">
      <ColorSlider
        label="H"
        value={value.h}
        min={isColorize ? 0 : -180}
        max={isColorize ? 360 : 180}
        onChange={(v) => handleChange("h", v)}
      />
      <ColorSlider
        label="S"
        value={value.s}
        min={isColorize ? 0 : -100}
        max={100}
        onChange={(v) => handleChange("s", v)}
      />
      <ColorSlider
        label="B"
        value={value.b}
        min={-100}
        max={100}
        onChange={(v) => handleChange("b", v)}
      />
      <ColorSlider
        label="C"
        value={value.c}
        min={-100}
        max={100}
        onChange={(v) => handleChange("c", v)}
      />
      {showColorizeToggle && (
        <label className="flex items-center gap-4 text-sm text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={!!value.colorize}
            onChange={(e) =>
              onChange({ ...value, colorize: e.target.checked || undefined })
            }
            className="accent-accent"
          />
          Colorize
        </label>
      )}
    </div>
  );
}
