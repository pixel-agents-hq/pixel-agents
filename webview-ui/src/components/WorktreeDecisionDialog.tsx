import type { ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type {
  AgentCloseQuestion,
  Directory,
  WorktreeLeaveChoice,
} from '../../../core/src/messages.js';
import type { WorktreeDecisionError } from '../hooks/useExtensionMessages.js';
import { transport } from '../transport/index.js';
import {
  decisionKey,
  newlyPending,
  nextDecision,
  type WorktreesByDirectory,
} from '../worktrees/worktreeDecisions.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';
import { PixelIcon } from './ui/PixelIcon.js';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** "1 file" inside a sentence, kept on one line. */
function FileCount({ n }: { n: number }) {
  return (
    <span className="whitespace-nowrap">
      {n} {n === 1 ? 'file' : 'files'}
    </span>
  );
}

/**
 * The question a Worktree agent leaves behind when it goes with uncommitted
 * changes: Commit to branch (the default: commit them to its branch, then
 * free the folder), Leave as is, or Delete changes (after a second
 * confirmation naming how many files are lost). One Worktree at a time; every privileged office asks,
 * and an answer from any of them clears it everywhere (the server's next
 * `worktreesLoaded` no longer lists it as waiting). Closing it without an
 * answer puts it off in this office; it still waits on the server.
 *
 * Mounted at App's top level, so both shells show it.
 */
export function WorktreeDecisionDialog({
  worktreesByDirectory,
  directories,
  error,
}: {
  worktreesByDirectory: WorktreesByDirectory;
  directories: readonly Directory[];
  error: WorktreeDecisionError | null;
}) {
  // Answered here and waiting for the server's word, or put off for later.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [shownError, setShownError] = useState<WorktreeDecisionError | null>(null);

  // A refused answer: ask again, saying why.
  useEffect(() => {
    if (!error) return;
    const key = decisionKey(error.directoryPath, error.name);
    setAnswered((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setShownError(error);
  }, [error]);

  // One that comes to need a decision again (a Remove from the Worktrees
  // list that found changes, a kept folder flagged by the sweep) is a new
  // question: no longer put off or answered here.
  const previousLists = useRef(worktreesByDirectory);
  useEffect(() => {
    const fresh = newlyPending(previousLists.current, worktreesByDirectory);
    previousLists.current = worktreesByDirectory;
    if (fresh.length === 0) return;
    const without = (prev: ReadonlySet<string>) => {
      if (!fresh.some((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of fresh) next.delete(k);
      return next;
    };
    setLater(without);
    setAnswered(without);
  }, [worktreesByDirectory]);

  const hidden = useMemo(() => new Set([...answered, ...later]), [answered, later]);
  const pending = nextDecision(worktreesByDirectory, hidden);
  const key = pending ? decisionKey(pending.directoryPath, pending.worktree.name) : null;

  // Keep the last question on screen while the dialog drops away.
  const last = useRef(pending);
  if (pending) last.current = pending;
  const shown = pending ?? last.current;
  if (!shown) return null;

  const { directoryPath, worktree } = shown;
  const directory = directories.find((d) => d.path === directoryPath);
  const count = worktree.uncommittedFiles;
  const errorHere =
    shownError && shownError.directoryPath === directoryPath && shownError.name === worktree.name
      ? shownError.reason
      : null;

  const answer = (choice: WorktreeLeaveChoice) => {
    transport.send({
      type: 'decideWorktree',
      directoryPath,
      name: worktree.name,
      choice,
      ...(choice === 'discard' ? { confirmedFiles: count } : {}),
    });
    setShownError(null);
    setAnswered((prev) => new Set(prev).add(decisionKey(directoryPath, worktree.name)));
  };
  const putOff = () => {
    setLater((prev) => new Set(prev).add(decisionKey(directoryPath, worktree.name)));
  };

  return (
    <Modal isOpen={pending !== null} onClose={putOff} title={<UncommittedTitle n={count} />}>
      <ChoicePanel
        key={key ?? undefined}
        testId="worktree-decision"
        name={worktree.name}
        branch={worktree.branch}
        directoryName={directory?.name}
        count={count}
        error={errorHere}
        onAnswer={answer}
      />
    </Modal>
  );
}

/**
 * The same question asked BEFORE an agent is closed: its card's × found
 * uncommitted files in its Worktree, so the server kept it running and asked
 * this office. An answer closes the agent and is applied to the Worktree once
 * it has exited; closing the dialog leaves the agent running.
 */
export function CloseAgentQuestionDialog({
  question,
  directories,
  onDone,
}: {
  question: AgentCloseQuestion | null;
  directories: readonly Directory[];
  onDone: () => void;
}) {
  // Keep the last question on screen while the dialog drops away.
  const last = useRef(question);
  if (question) last.current = question;
  const shown = question ?? last.current;
  if (!shown) return null;

  const directory = directories.find((d) => d.path === shown.directoryPath);
  const answer = (choice: WorktreeLeaveChoice) => {
    transport.send({
      type: 'closeAgent',
      id: shown.id,
      worktreeChoice: choice,
      ...(choice === 'discard' ? { confirmedFiles: shown.uncommittedFiles } : {}),
    });
    onDone();
  };

  return (
    <Modal
      isOpen={question !== null}
      onClose={onDone}
      title={<UncommittedTitle n={shown.uncommittedFiles} />}
    >
      <ChoicePanel
        // A question asked again (more files now) starts at its first step.
        key={`${shown.id}:${shown.name}:${shown.uncommittedFiles}`}
        testId="worktree-close-question"
        name={shown.name}
        branch={shown.branch}
        directoryName={directory?.name}
        count={shown.uncommittedFiles}
        error={null}
        onAnswer={answer}
      />
    </Modal>
  );
}

/** A choice for the files a Worktree holds, as the panel names it. */
export type WorktreeFilesChoice = 'save' | 'keep' | 'discard';

const CHOICE_LOOKS: Record<
  WorktreeFilesChoice,
  { label: string; caption: (branch: string) => string; testId: string }
> = {
  save: {
    label: 'Commit to branch',
    caption: (branch) =>
      `Saved on branch ${branch}; the worktree folder is deleted to free up space.`,
    testId: 'worktree-choice-commit',
  },
  keep: {
    label: 'Leave as is',
    caption: () => 'Leave uncommitted, the worktree folder stays, you can resume anytime later.',
    testId: 'worktree-choice-leave',
  },
  discard: {
    label: 'Delete changes',
    caption: () => 'Discard worktree entirely.',
    testId: 'worktree-choice-delete',
  },
};

/** A dialog's title: "You have 1 uncommitted file". */
function UncommittedTitle({ n }: { n: number }) {
  return (
    <span>
      You have {n} uncommitted {n === 1 ? 'file' : 'files'}
    </span>
  );
}

/** Where the files are: "in ⑂ brave-otter (Directory)". */
function WhereLine({ branch, directoryName }: { branch: string; directoryName?: string }) {
  return (
    <p className="text-sm m-0 break-words text-text-muted">
      in{' '}
      <span className="whitespace-nowrap text-text">
        <PixelIcon name="worktree" scale={1} className="inline-block align-baseline mr-4" />
        {branch}
      </span>
      {directoryName ? ` (${directoryName})` : ''}
    </p>
  );
}

/**
 * What to do with the files a Worktree holds, as stacked choices: each a row
 * naming what happens and, under it, its consequence. Pressing one answers;
 * Delete changes first asks once more, naming how many files go. Shared by
 * both dialogs and the Worktrees list's panel under a row (which leaves out
 * Leave as is: Back does that there).
 */
export function WorktreeChoices({
  testId,
  name,
  heading,
  branch,
  count,
  choices = ['save', 'keep', 'discard'],
  error,
  onAnswer,
  onBack,
}: {
  testId: string;
  /** The Worktree's name (`data-worktree`, for finding it). */
  name: string;
  /** Above the choices: where the files are, or how many. */
  heading: ReactNode;
  branch: string;
  count: number;
  choices?: readonly WorktreeFilesChoice[];
  error: string | null;
  onAnswer: (choice: WorktreeFilesChoice) => void;
  /** A Back button below the choices (the list's panel). */
  onBack?: () => void;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const captionIds = useId();
  return (
    <div data-testid={testId} data-worktree={name} className="flex flex-col gap-6 max-w-md">
      {heading}
      {error && (
        <p role="alert" className="text-xs text-danger m-0 break-words">
          {error}
        </p>
      )}
      {confirmingDiscard ? (
        <>
          <p className="text-sm m-0">
            Delete <FileCount n={count} /> for good?
          </p>
          <div className="flex gap-4 justify-end flex-wrap">
            <Button variant="default" size="sm" onClick={() => setConfirmingDiscard(false)}>
              Back
            </Button>
            <Button
              variant="default"
              size="sm"
              className="text-danger!"
              data-testid="worktree-confirm-delete-files"
              onClick={() => onAnswer('discard')}
            >
              Delete {files(count)}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div role="group" aria-label="What to do with them" className="flex flex-col">
            {choices.map((choice, i) => {
              const look = CHOICE_LOOKS[choice];
              const captionId = `${captionIds}-${choice}`;
              return (
                <button
                  key={choice}
                  type="button"
                  data-testid={look.testId}
                  aria-label={look.label}
                  aria-describedby={captionId}
                  autoFocus={i === 0}
                  data-default={choice === 'save' ? 'true' : undefined}
                  onClick={() =>
                    choice === 'discard' ? setConfirmingDiscard(true) : onAnswer(choice)
                  }
                  className="group w-full flex flex-col px-6 py-4 bg-transparent border-2 border-transparent rounded-none cursor-pointer text-left leading-tight hover:bg-btn-bg hover:border-border focus-visible:border-accent"
                >
                  {/* The arrow and the label share one line, centred together;
                      the caption hangs under the label. */}
                  <span className="flex items-center gap-6">
                    <span
                      className={`shrink-0 flex ${choice === 'discard' ? 'text-danger' : 'text-text-muted group-hover:text-text'}`}
                    >
                      <PixelIcon name="next" scale={1} />
                    </span>
                    <span
                      className={`text-sm ${choice === 'discard' ? 'text-danger' : 'text-text'}`}
                    >
                      {look.label}
                    </span>
                  </span>
                  <span id={captionId} className="pl-14 text-2xs text-text-muted break-words">
                    {look.caption(branch)}
                  </span>
                </button>
              );
            })}
          </div>
          {onBack && (
            <div className="flex justify-end">
              <Button variant="default" size="sm" onClick={onBack}>
                Back
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The question's body, both dialogs': where the files are, then the
 *  choices. */
function ChoicePanel({
  testId,
  name,
  branch,
  directoryName,
  count,
  error,
  onAnswer,
}: {
  testId: string;
  name: string;
  branch: string;
  directoryName: string | undefined;
  count: number;
  error: string | null;
  onAnswer: (choice: WorktreeLeaveChoice) => void;
}) {
  return (
    <div className="px-10 py-4">
      <WorktreeChoices
        testId={testId}
        name={name}
        heading={<WhereLine branch={branch} directoryName={directoryName} />}
        branch={branch}
        count={count}
        error={error}
        onAnswer={onAnswer}
      />
    </div>
  );
}
