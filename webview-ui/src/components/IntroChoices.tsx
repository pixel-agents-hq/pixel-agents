import { useState } from 'react';

import { INTRO_DIALOG_MENU_GAP_PX } from '../constants.js';
import { IntroOption, IntroOptions, IntroPanel } from './IntroOptions.js';
import { Checkbox } from './ui/Checkbox.js';

export type IntroChoiceId = 'usage' | 'hooks' | 'mcp';

export interface IntroChoiceOption {
  id: IntroChoiceId;
  label: string;
  /** One line beside the box (the server's). */
  summary: string;
  /** The full terms behind "Read more" (the server's; paragraphs on blank lines). */
  disclosure: string;
  /** Why turning it on failed, when it did. */
  error?: string;
}

interface IntroChoicesProps {
  options: readonly IntroChoiceOption[];
  values: Readonly<Record<IntroChoiceId, boolean>>;
  onToggle: (id: IntroChoiceId) => void;
  /** Something being turned on has not answered yet: the step holds. */
  pending: boolean;
  /** Ask before going on with every box off (only where that limits the office a lot). */
  warnAllOff: boolean;
  onBack?: () => void;
  onContinue: () => void;
}

/**
 * The Intro's choices step: what to turn on (usage bars, live updates through
 * hooks, the Pixel Office MCP), one card each in a row, all off to start, each
 * with one line and its full terms behind "Read more" (shown under the row). Continue applies the boxes as
 * they stand (IntroDialog sends the answers; the greeter says they can be
 * changed later in Settings); with every box off it first
 * says what that costs.
 */
export function IntroChoices({
  options,
  values,
  onToggle,
  pending,
  warnAllOff,
  onBack,
  onContinue,
}: IntroChoicesProps) {
  const [open, setOpen] = useState<IntroChoiceId | null>(null);
  const [warning, setWarning] = useState(false);
  const allOff = options.every((o) => !values[o.id]);

  const opened = options.find((o) => o.id === open);

  return (
    <>
      {/* One card per choice, side by side (they wrap where the office is narrow). */}
      <div
        className="flex flex-wrap items-stretch w-full"
        style={{ gap: INTRO_DIALOG_MENU_GAP_PX }}
      >
        {options.map((option) => (
          <IntroPanel
            key={option.id}
            className="flex-1 basis-0 min-w-[150px]"
            data-testid={`intro-choice-${option.id}`}
          >
            <Checkbox
              variant="inline"
              className="text-left"
              checked={values[option.id]}
              onChange={() => {
                setWarning(false);
                onToggle(option.id);
              }}
              label={<span className="text-base text-accent-bright">{option.label}</span>}
            />
            <p className="text-sm m-0 mt-4">
              {option.summary}{' '}
              <button
                type="button"
                aria-expanded={open === option.id}
                className="p-0 bg-transparent border-0 text-sm text-accent hover:text-accent-bright cursor-pointer underline"
                onClick={() => setOpen(open === option.id ? null : option.id)}
              >
                {open === option.id ? 'Show less' : 'Read more'}
              </button>
            </p>
            {option.error && !pending && (
              <p className="text-sm m-0 mt-4 text-status-error">{option.error}</p>
            )}
          </IntroPanel>
        ))}
      </div>

      {/* The opened card's full terms, the dialog's width. */}
      {opened && (
        <IntroPanel wide data-testid="intro-choice-terms">
          <p className="text-sm m-0 text-accent-bright">{opened.label}</p>
          {opened.disclosure.split('\n\n').map((paragraph, i) => (
            <p key={i} className="text-sm m-0 mt-4 text-text-muted">
              {paragraph}
            </p>
          ))}
        </IntroPanel>
      )}

      {warning && (
        <IntroPanel>
          <p className="text-sm m-0 text-warning" data-testid="intro-choices-warning">
            With everything off, your agents only show up after a delay and the office can&apos;t
            give you its tour. Sure?
          </p>
        </IntroPanel>
      )}

      <IntroOptions>
        {warning ? (
          <>
            <IntroOption kind="primary" onClick={onContinue}>
              Continue Anyway
            </IntroOption>
            <IntroOption onClick={() => setWarning(false)}>Choose Again</IntroOption>
          </>
        ) : (
          <IntroOption
            kind="primary"
            disabled={pending}
            onClick={() => (warnAllOff && allOff ? setWarning(true) : onContinue())}
          >
            {pending ? 'Setting up...' : 'Continue'}
          </IntroOption>
        )}
        {onBack && (
          <IntroOption kind="back" disabled={pending} onClick={onBack}>
            Back
          </IntroOption>
        )}
      </IntroOptions>
    </>
  );
}
