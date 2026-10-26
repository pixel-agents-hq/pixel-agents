import { useEffect, useRef, useState } from 'react';

import type { UsageLimits } from '../../../core/src/messages.js';
import { PixelText } from '../components/ui/PixelText.js';
import {
  CONTEXT_GAUGE_COLOR_YELLOW,
  USAGE_BAR_HEIGHT_PX,
  USAGE_BAR_TICK_MS,
  USAGE_BAR_WIDTH_PX,
  USAGE_BARS_LEFT_PX,
} from '../constants.js';
import { PixelHeart } from './PixelHeart.js';
import {
  freshnessLabel,
  heartBeatPeriodSec,
  type UsageBarView,
  usageBarView,
} from './usageBarView.js';

type BarId = 'weekly' | 'fiveHour';

/** Fill colour per bar and level. The two bars differ all the way down,
 *  like a game's health and stamina: weekly green → yellow → red, 5-hour
 *  blue → purple → red (yellow at half would make them look alike). */
const FILL: Record<BarId, Record<UsageBarView['level'], string>> = {
  weekly: {
    ok: 'var(--color-status-success)',
    warn: CONTEXT_GAUGE_COLOR_YELLOW,
    low: 'var(--color-danger)',
    unknown: 'transparent',
  },
  fiveHour: {
    ok: 'var(--color-status-active)',
    warn: 'var(--color-usage-five-hour-warn)',
    low: 'var(--color-danger)',
    unknown: 'transparent',
  },
};
/** Each bar's name, before its reset time on hover. */
const BAR_NAME: Record<BarId, string> = { weekly: 'Weekly', fiveHour: '5-hour' };

interface UsageBarsProps {
  /** The last usageLimits for the provider; undefined until the server sends it. */
  limits: UsageLimits | undefined;
  /** Phone: below the safe area, beside the menu button. */
  mobile: boolean;
}

/** The current time, re-read every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** A bar's name and when it resets: "Weekly · resets in 3d 11h". */
function ResetLabel({ id, view }: { id: BarId; view: UsageBarView }) {
  return (
    <PixelText text={`${BAR_NAME[id]} · ${view.reset}`} shadow className="text-2xs text-text" />
  );
}

/** One bar with its share left printed inside, and (while the section is
 *  hovered or tapped) when it resets, just right of it. */
function BarRow({ id, view, showReset }: { id: BarId; view: UsageBarView; showReset: boolean }) {
  return (
    <div className="flex items-center gap-4">
      <div
        className="relative bg-bg-dark border-2 border-border box-content flex items-center pl-4"
        style={{ width: USAGE_BAR_WIDTH_PX, height: USAGE_BAR_HEIGHT_PX }}
      >
        <div
          className="absolute left-0 top-0 bottom-0"
          style={{
            width: `${(view.remaining ?? 0) * 100}%`,
            background: FILL[id][view.level],
          }}
        />
        <PixelText text={view.percent} shadow className="relative text-2xs text-text" />
      </div>
      {showReset && <ResetLabel id={id} view={view} />}
    </div>
  );
}

/**
 * Top-left of the office: how much of the Claude Code plan is left. A heart,
 * then the weekly bar (green) over the 5-hour bar (blue), equal in size, each
 * draining through its own colours to red,
 * each with its share left inside. Hovering any of it makes the heart beat, at a
 * pace proportional to the weekly plan left, and shows when each bar resets,
 * right of it. On a phone a tap does it instead (a tap elsewhere undoes it),
 * with the reset times below the bars, where the narrow screen has room.
 */
export function UsageBars({ limits, mobile }: UsageBarsProps) {
  const now = useNow(USAGE_BAR_TICK_MS);
  const [active, setActive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Phone: a tap anywhere else closes it again.
  useEffect(() => {
    if (!mobile || !active) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setActive(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [mobile, active]);
  const weekly = usageBarView(limits?.sevenDay, now);
  const fiveHour = usageBarView(limits?.fiveHour, now);
  // Reset times: right of each bar on a desktop, below the bars on a phone.
  const showResetBeside = active && !mobile;

  return (
    <div
      ref={rootRef}
      className={`absolute z-10 flex items-center gap-8 cursor-default ${mobile ? 'mobile-safe-top' : 'top-8'}`}
      style={{ left: USAGE_BARS_LEFT_PX }}
      title={freshnessLabel(limits?.updatedAt, now)}
      aria-label={`Claude Code usage. Weekly: ${weekly.percent} left, ${weekly.reset}. 5-hour: ${fiveHour.percent} left, ${fiveHour.reset}.`}
      // A phone's tap also fires the emulated mouseenter, which would cancel
      // the click's toggle, so there only the tap counts.
      onMouseEnter={mobile ? undefined : () => setActive(true)}
      onMouseLeave={mobile ? undefined : () => setActive(false)}
      onClick={mobile ? () => setActive((a) => !a) : undefined}
    >
      <PixelHeart periodSec={active ? heartBeatPeriodSec(weekly.remaining) : null} />
      <div className="flex flex-col gap-2">
        <BarRow id="weekly" view={weekly} showReset={showResetBeside} />
        <BarRow id="fiveHour" view={fiveHour} showReset={showResetBeside} />
      </div>
      {active && mobile && (
        <div className="absolute top-full left-0 mt-6 flex flex-col gap-4 pointer-events-none">
          <ResetLabel id="weekly" view={weekly} />
          <ResetLabel id="fiveHour" view={fiveHour} />
        </div>
      )}
    </div>
  );
}
