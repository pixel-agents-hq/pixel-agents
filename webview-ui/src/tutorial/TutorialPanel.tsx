import { useEffect, useState } from 'react';

import type { TutorialRun } from '../../../core/src/messages.js';
import { tutorialQuest } from '../../../core/src/tutorial/quests.js';
import { Button } from '../components/ui/Button.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import { PixelText } from '../components/ui/PixelText.js';
import {
  AGENT_CARD_HEIGHT_PX,
  TUTORIAL_COMPLETE_FADE_MS,
  TUTORIAL_COMPLETE_LINGER_MS,
} from '../constants.js';

interface TutorialPanelProps {
  run: TutorialRun;
  onSkip: (questId: string) => void;
  /** End the run (the server closes the Guide's session). */
  onQuit: () => void;
  /** Pixels kept clear at the office's right edge (the desktop card bar overlaps it). */
  rightInset: number;
  /** Pixels from the office's top. */
  top: number;
}

/** The panel's border (pixel-panel: 2px), inside the card's height. */
const BORDER_PX = 2;

/** An up/down arrow that turns with `open` (the roster arrow's turn). */
function Turn({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${open ? 'rotate-180' : ''}`}
    >
      <PixelIcon name="down" scale={1} />
    </span>
  );
}

/** A quest's box: empty while open, ticked when done, struck when skipped. */
function QuestBox({ state }: { state: string }) {
  return (
    <span
      aria-hidden
      className="shrink-0 w-14 h-14 border-2 border-current flex items-center justify-center"
    >
      {state === 'done' && <PixelIcon name="check" scale={1} />}
      {state === 'skipped' && <span className="w-6 h-2 bg-current" />}
    </span>
  );
}

/** Where a run's checklist is: showing, fading once every quest closed, gone. */
type Phase = 'shown' | 'fading' | 'gone';

/**
 * The tutorial's checklist, top-right of the office while a run is under way:
 * its few first steps, in any order. Pressing one shows what to do and Skip;
 * Quit is asked once, since it closes the Guide's session. Collapsed to its
 * header until opened: the tour itself is the Guide's conversation. Once every
 * quest is done or skipped it says so, then fades away; the Guide stays.
 */
export function TutorialPanel({ run, onSkip, onQuit, rightInset, top }: TutorialPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // A run already finished when this office opened has nothing left to show.
  const [phase, setPhase] = useState<Phase>(run.finished ? 'gone' : 'shown');
  const closed = run.quests.filter((q) => q.state !== 'open').length;

  // Keyed on the finish alone: the fade's own phase change must not cancel its end.
  useEffect(() => {
    if (!run.finished) return;
    const fade = setTimeout(() => setPhase('fading'), TUTORIAL_COMPLETE_LINGER_MS);
    const gone = setTimeout(
      () => setPhase('gone'),
      TUTORIAL_COMPLETE_LINGER_MS + TUTORIAL_COMPLETE_FADE_MS,
    );
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [run.finished]);

  if (phase === 'gone') return null;

  return (
    <div
      className="absolute z-20 pixel-panel px-10 text-sm"
      style={{
        top,
        right: 8 + rightInset,
        width: 280,
        maxWidth: 'calc(100% - 32px)',
        opacity: phase === 'fading' ? 0 : 1,
        transition: `opacity ${TUTORIAL_COMPLETE_FADE_MS}ms`,
      }}
      data-testid="tutorial-panel"
      data-finished={run.finished ? 'true' : 'false'}
    >
      {/* As tall as an agent card, so the collapsed panel lines up with the Guide's. */}
      <div
        className="flex items-center justify-between gap-6"
        style={{ height: AGENT_CARD_HEIGHT_PX - 2 * BORDER_PX }}
      >
        <span className="text-accent-bright flex items-center gap-6">
          {run.finished ? (
            'Tutorial complete!'
          ) : (
            <>
              Tutorial <PixelText text={`${closed} / ${run.quests.length}`} />
            </>
          )}
        </span>
        {!run.finished && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={collapsed ? 'Show quests' : 'Hide quests'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <Turn open={!collapsed} />
          </Button>
        )}
      </div>

      {!collapsed && !run.finished && (
        <>
          <ul className="list-none m-0 pl-0 flex flex-col">
            {run.quests.map(({ id, state }) => {
              const quest = tutorialQuest(id);
              const open = state === 'open';
              const shown = open && expanded === id;
              return (
                <li
                  key={id}
                  className="border-t-2 border-border"
                  data-testid={`tutorial-quest-${id}`}
                  data-state={state}
                >
                  <button
                    type="button"
                    className={`flex items-center gap-8 w-full text-left bg-transparent border-0 py-6 px-4 text-inherit ${
                      open
                        ? 'cursor-pointer hover:bg-panel-hover hover:text-accent-bright'
                        : 'cursor-default text-text-muted'
                    }`}
                    aria-expanded={open ? shown : undefined}
                    disabled={!open}
                    onClick={() => setExpanded(shown ? null : id)}
                  >
                    <QuestBox state={state} />
                    <span className={`flex-1 ${state === 'skipped' ? 'line-through' : ''}`}>
                      {quest?.title ?? id}
                    </span>
                    {open && <Turn open={shown} />}
                  </button>
                  {shown && (
                    <div className="pl-26 pr-4 pb-6">
                      <p className="m-0 mb-4 text-xs">{quest?.goal}</p>
                      <div className="flex justify-end">
                        <Button variant="ghost" size="sm" onClick={() => onSkip(id)}>
                          Skip
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="border-t-2 border-border pt-6 pb-6">
            {confirmQuit ? (
              <div className="flex flex-col gap-4">
                <span className="text-xs">Quit the tutorial and close its session?</span>
                <div className="flex gap-6">
                  <Button variant="default" size="sm" onClick={() => setConfirmQuit(false)}>
                    Keep Playing
                  </Button>
                  <Button variant="accent" size="sm" onClick={onQuit}>
                    Quit
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmQuit(true)}>
                Quit Tutorial
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
