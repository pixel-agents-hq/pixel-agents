import { useState } from 'react';

import { Button } from './ui/Button.js';
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
 * hooks, the Pixel Office MCP), one box each, all off to start, each with one
 * line and its full terms behind "Read more". Continue applies the boxes as
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

  return (
    <>
      {options.map((option) => (
        <div key={option.id} className="mb-10" data-testid={`intro-choice-${option.id}`}>
          <Checkbox
            variant="inline"
            checked={values[option.id]}
            onChange={() => {
              setWarning(false);
              onToggle(option.id);
            }}
            label={<span className="text-base text-accent-bright">{option.label}</span>}
          />
          <p className="text-sm m-0 mt-2 pl-24">
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
          {open === option.id &&
            option.disclosure.split('\n\n').map((paragraph, i) => (
              <p key={i} className="text-sm m-0 mt-4 pl-24 text-text-muted">
                {paragraph}
              </p>
            ))}
          {option.error && !pending && (
            <p className="text-sm m-0 mt-4 pl-24 text-status-error">{option.error}</p>
          )}
        </div>
      ))}

      {warning && (
        <p className="text-sm m-0 mb-8 text-warning" data-testid="intro-choices-warning">
          With everything off, your agents only show up after a delay and the office can&apos;t give
          you its tour. Sure?
        </p>
      )}

      <div className="flex items-center justify-between gap-6 mt-4 flex-wrap">
        {onBack ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        {warning ? (
          <div className="flex items-center justify-end gap-6 flex-wrap">
            <Button variant="default" size="sm" onClick={() => setWarning(false)}>
              Choose Again
            </Button>
            <Button variant="accent" size="sm" onClick={onContinue}>
              Continue Anyway
            </Button>
          </div>
        ) : (
          <Button
            variant={pending ? 'disabled' : 'accent'}
            size="sm"
            disabled={pending}
            onClick={() => (warnAllOff && allOff ? setWarning(true) : onContinue())}
          >
            {pending ? 'Setting up...' : 'Continue'}
          </Button>
        )}
      </div>
    </>
  );
}
