import { Button } from '../components/ui/Button.js';
import { TV_EXIT_ATTR, TV_EXIT_FADE_SEC } from './constants.js';

/** A TV set — "TV mode". */
function TvIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="3" width="14" height="10" stroke="currentColor" strokeWidth="2" />
      <path d="M6 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

interface TvModeButtonProps {
  onClick: () => void;
  /** Phones: the small square the floating Fit button uses. */
  compact?: boolean;
}

/** Enter TV mode: fullscreen, every control hidden. Under Fit in the zoom
 *  stack on desktop, beside Fit in the floating row on phones. */
export function TvModeButton({ onClick, compact = false }: TvModeButtonProps) {
  return (
    <Button
      size={compact ? 'sm' : 'icon_lg'}
      onClick={onClick}
      className={`border-border! shadow-pixel ${compact ? 'flex items-center self-stretch' : ''}`}
      title="TV mode (T): fullscreen, controls hidden"
      aria-label="TV mode"
      data-testid="tv-mode-button"
    >
      <TvIcon />
    </Button>
  );
}

interface TvExitButtonProps {
  /** Shown while the viewer is active (useTvMode.active); fades out when idle. */
  visible: boolean;
  onClick: () => void;
}

/**
 * The way out of TV mode on screen: top-right, fading in on a mouse move or
 * a tap and out again after TV_IDLE_MS. Esc and T leave too; this is for the
 * viewer who doesn't know that. Plain 8px offsets: in TV mode the board is
 * already padded by the safe-area insets (TV_SAFE_AREA_PADDING).
 */
export function TvExitButton({ visible, onClick }: TvExitButtonProps) {
  return (
    <div
      className={`absolute top-8 right-8 z-40 ${visible ? '' : 'pointer-events-none'}`}
      style={{
        opacity: visible ? 1 : 0,
        transition: `opacity ${TV_EXIT_FADE_SEC}s ease-out`,
      }}
      aria-hidden={!visible}
      data-testid="tv-exit"
      {...{ [TV_EXIT_ATTR]: '' }}
    >
      <Button
        size="sm"
        className="border-border! shadow-pixel"
        onClick={onClick}
        title="Leave TV mode (Esc)"
        aria-label="Exit TV mode"
        data-testid="tv-exit-button"
      >
        Exit TV
      </Button>
    </div>
  );
}
