import { useState } from 'react';

import type { WorktreeSummary } from '../../../core/src/messages.js';
import type { TabStatus } from '../components/AgentCard.js';
import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { STATUS_DOT } from '../components/statusDot.js';
import { Button } from '../components/ui/Button.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import type { PixelIconName } from '../components/ui/pixelIcons.js';
import { WorktreeChoices } from '../components/WorktreeDecisionDialog.js';
import { MUGSHOT_CROP_SIDE_PX, WORKTREE_ROW_BUTTON_PX } from '../constants.js';
import type { WorktreeDecisionError } from '../hooks/useExtensionMessages.js';
import { transport } from '../transport/index.js';
import {
  deleteNeedsConfirmation,
  formatSize,
  removeNeedsConfirmation,
  type WorktreeAction,
  worktreeActions,
  worktreeStateLabel,
} from '../worktrees/worktreeList.js';

/** What the conversation list needs to show each Directory's Worktrees. */
export interface WorktreesListing {
  /** Each Directory's Worktrees as the server last listed them. */
  byDirectory: Readonly<Record<string, readonly WorktreeSummary[]>>;
  /** The name of the CLI whose own worktrees are listed (`worktreesLoaded`'s
   *  `cliName`); undefined = the server named none. */
  cliName?: string;
  /** The last refused Worktree action this office sent (shown on its row). */
  error: WorktreeDecisionError | null;
}

interface WorktreeListProps {
  directoryPath: string;
  worktrees: readonly WorktreeSummary[];
  /** Names the CLI on its own worktrees' badge (`<cliName>'s`). */
  cliName?: string;
  error: WorktreeDecisionError | null;
  /** Resume a conversation (the Worktree's latest). */
  onResume: (sessionId: string, directoryPath: string) => void;
  onOpenAgent: (agentId: number) => void;
  /** A running agent's card status: its row's dot takes that colour. */
  statusFor: (agentId: number) => TabStatus | null;
  roomy: boolean;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The row's inline removal, by action: its icon, tooltip and test id. */
const REMOVAL_LOOKS: Record<
  'remove' | 'deleteBranch',
  { icon: PixelIconName; title: (worktree: WorktreeSummary) => string; testId: string }
> = {
  remove: {
    icon: 'trash',
    title: (w) => (w.owner === 'cli' ? 'Remove its folder and branch' : 'Remove its folder'),
    testId: 'worktree-remove',
  },
  deleteBranch: {
    icon: 'trash',
    title: () => 'Delete its branch',
    testId: 'worktree-delete-branch',
  },
};

/**
 * A Directory's Worktrees, under its conversations: the agent's mug shot
 * (looking right, along the row), branch, state, size on disk and
 * what it holds. Pressing the row goes to its running agent, or resumes its
 * latest conversation; what removes something (the folder by the leave rules,
 * a parked branch, one of Claude Code's whole) is a small trash button at its
 * end, confirmed first when it loses work.
 */
export function WorktreeList({
  directoryPath,
  worktrees,
  cliName,
  error,
  onResume,
  onOpenAgent,
  statusFor,
  roomy,
}: WorktreeListProps) {
  // The row whose removal is being confirmed under it: a parked branch's
  // delete, a Claude Code worktree's remove, or ours with uncommitted files
  // (save or discard them, as the leave dialog would ask).
  const [confirming, setConfirming] = useState<{
    name: string;
    choice: 'remove' | 'deleteBranch';
  } | null>(null);
  if (worktrees.length === 0) return null;

  const decide = (
    worktree: WorktreeSummary,
    choice: 'remove' | 'deleteBranch' | 'save' | 'discard',
  ) => {
    const cliMade = worktree.owner === 'cli';
    transport.send({
      type: 'decideWorktree',
      directoryPath,
      name: worktree.name,
      choice,
      // What the user was shown losing: the server refuses to lose more.
      ...(choice === 'deleteBranch' || cliMade ? { confirmedCommits: worktree.uniqueCommits } : {}),
      ...(cliMade || choice === 'discard' ? { confirmedFiles: worktree.uncommittedFiles } : {}),
    });
    setConfirming(null);
  };
  const askOrDecide = (worktree: WorktreeSummary, choice: 'remove' | 'deleteBranch') => {
    const ask =
      choice === 'deleteBranch'
        ? deleteNeedsConfirmation(worktree)
        : removeNeedsConfirmation(worktree);
    if (ask) setConfirming({ name: worktree.name, choice });
    else decide(worktree, choice);
  };

  return (
    <div data-testid="worktree-list" className="py-2 border-b-2 border-border">
      <h4 className="m-0 px-10 pt-4 pb-2 text-2xs font-normal tracking-wider uppercase text-text-muted">
        Worktrees
      </h4>
      {worktrees.map((worktree) => {
        const actions = worktreeActions(worktree);
        const removal = actions.find(
          (a): a is 'remove' | 'deleteBranch' => a === 'remove' || a === 'deleteBranch',
        );
        const press = pressOf(actions, worktree, directoryPath, onOpenAgent, onResume);
        const errorHere =
          error && error.directoryPath === directoryPath && error.name === worktree.name
            ? error.reason
            : null;
        const details = [
          worktreeStateLabel(worktree),
          ...(worktree.sizeBytes > 0 ? [formatSize(worktree.sizeBytes)] : []),
          ...(worktree.uncommittedFiles > 0
            ? [count(worktree.uncommittedFiles, 'change', 'changes')]
            : []),
          ...(worktree.uniqueCommits > 0
            ? [count(worktree.uniqueCommits, 'commit', 'commits')]
            : []),
        ];
        const body = (
          <>
            <span className="shrink-0 flex" style={{ width: MUGSHOT_CROP_SIDE_PX }}>
              {worktree.palette !== undefined ? (
                // The agent it belongs to (the server decides whose).
                <CharacterMugShot
                  palette={worktree.palette}
                  repeat={worktree.repeat ?? 0}
                  zoom={1}
                  facing="right"
                />
              ) : (
                // No agent of its own seen yet: it gets a character when one runs.
                <span
                  aria-hidden="true"
                  className="border-2 border-dashed border-border"
                  style={{ width: MUGSHOT_CROP_SIDE_PX, height: MUGSHOT_CROP_SIDE_PX }}
                />
              )}
            </span>
            <span className="flex-1 min-w-0 flex flex-col leading-none">
              <span className="flex items-center gap-4 min-w-0">
                <span className="shrink-0 flex text-text-muted">
                  <PixelIcon name="worktree" scale={1} />
                </span>
                <span
                  className="min-w-0 text-sm overflow-hidden text-ellipsis whitespace-nowrap"
                  title={worktree.branch}
                >
                  {worktree.branch}
                </span>
                {worktree.owner === 'cli' && (
                  <span
                    className="shrink-0 px-4 text-2xs text-text-muted border-2 border-border whitespace-nowrap"
                    title={cliName ? `Made by ${cliName}` : 'Made by the CLI'}
                  >
                    {cliName ? `${cliName}'s` : "CLI's"}
                  </span>
                )}
              </span>
              <span className="text-2xs text-text-muted">{details.join(' · ')}</span>
            </span>
          </>
        );
        const rowLayout = `flex-1 min-w-0 flex items-center gap-8 pl-10 ${roomy ? 'py-6' : 'py-3'}`;
        return (
          <div
            key={worktree.name}
            data-testid="worktree-row"
            data-worktree={worktree.name}
            data-owner={worktree.owner}
            data-state={worktree.state}
            className="flex flex-col"
          >
            <div className="flex items-center gap-4 pr-10 hover:bg-btn-bg">
              {press ? (
                <button
                  type="button"
                  data-testid={press.testId}
                  title={press.title}
                  onClick={press.run}
                  className={`${rowLayout} bg-transparent border-none rounded-none cursor-pointer text-left text-text`}
                >
                  {body}
                </button>
              ) : (
                <div className={`${rowLayout} text-text`}>{body}</div>
              )}
              {worktree.agentId !== undefined && (
                <RunningDot status={statusFor(worktree.agentId)} />
              )}
              {removal && confirming?.name !== worktree.name && (
                <button
                  type="button"
                  data-testid={REMOVAL_LOOKS[removal].testId}
                  aria-label={`${REMOVAL_LOOKS[removal].title(worktree)}: ${worktree.branch}`}
                  title={REMOVAL_LOOKS[removal].title(worktree)}
                  onClick={() => askOrDecide(worktree, removal)}
                  className="shrink-0 flex items-center justify-center p-0 bg-bg border-2 border-border rounded-none shadow-pixel cursor-pointer leading-none text-text-muted hover:text-danger"
                  style={{ width: WORKTREE_ROW_BUTTON_PX, height: WORKTREE_ROW_BUTTON_PX }}
                >
                  <PixelIcon name={REMOVAL_LOOKS[removal].icon} />
                </button>
              )}
            </div>
            {errorHere && (
              <p role="alert" className="m-0 px-10 pb-2 text-xs text-danger break-words">
                {errorHere}
              </p>
            )}
            {confirming?.name === worktree.name &&
              (confirming.choice === 'remove' && worktree.owner === 'pixelAgents' ? (
                // Ours with files in it: the leave question, under its row.
                <div className="px-10 pb-4">
                  <WorktreeChoices
                    testId="worktree-files-choice"
                    name={worktree.name}
                    heading={
                      <p className="m-0 text-xs text-text-muted">
                        <Count
                          n={worktree.uncommittedFiles}
                          one="uncommitted file"
                          many="uncommitted files"
                        />
                      </p>
                    }
                    branch={worktree.branch}
                    count={worktree.uncommittedFiles}
                    choices={['save', 'discard']}
                    error={null}
                    onAnswer={(choice) => decide(worktree, choice === 'save' ? 'save' : 'discard')}
                    onBack={() => setConfirming(null)}
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-2 px-10 pb-4">
                  <p className="m-0 text-xs break-words">
                    {confirming.choice === 'deleteBranch' ? (
                      <>
                        Delete {worktree.branch} and{' '}
                        <Count n={worktree.uniqueCommits} one="commit" many="commits" /> merged
                        nowhere else?
                      </>
                    ) : (
                      <>
                        Remove the folder and branch {worktree.branch}, losing{' '}
                        {worktree.uncommittedFiles > 0 && (
                          <Count
                            n={worktree.uncommittedFiles}
                            one="uncommitted file"
                            many="uncommitted files"
                          />
                        )}
                        {worktree.uncommittedFiles > 0 && worktree.uniqueCommits > 0 && ' and '}
                        {worktree.uniqueCommits > 0 && (
                          <Count n={worktree.uniqueCommits} one="commit" many="commits" />
                        )}{' '}
                        for good?
                      </>
                    )}
                  </p>
                  <div className="flex gap-4 justify-end flex-wrap">
                    <Button variant="default" size="sm" onClick={() => setConfirming(null)}>
                      Back
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="text-danger!"
                      data-testid="worktree-confirm-delete"
                      onClick={() => decide(worktree, confirming.choice)}
                    >
                      {confirming.choice === 'deleteBranch' ? 'Delete branch' : 'Remove'}
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** "2 commits" inside a sentence, kept on one line. */
function Count({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <span className="whitespace-nowrap">
      {n} {n === 1 ? one : many}
    </span>
  );
}

/** A running row's dot, its agent card's status colour (as a conversation's). */
function RunningDot({ status }: { status: TabStatus | null }) {
  return (
    <span
      aria-label={status ?? 'running'}
      className={`shrink-0 flex mx-4 ${status ? STATUS_DOT[status] : 'text-text-muted'}`}
    >
      <PixelIcon name="dot" scale={1} />
    </span>
  );
}

/** What pressing a row does: go to its running agent, or resume its latest
 *  conversation; null when neither is there (the row is not a button). */
function pressOf(
  actions: readonly WorktreeAction[],
  worktree: WorktreeSummary,
  directoryPath: string,
  onOpenAgent: (agentId: number) => void,
  onResume: (sessionId: string, directoryPath: string) => void,
): { run: () => void; title: string; testId: string } | null {
  if (actions.includes('open') && worktree.agentId !== undefined) {
    const agentId = worktree.agentId;
    return {
      run: () => onOpenAgent(agentId),
      title: `Go to the agent in ${worktree.branch}`,
      testId: 'worktree-open',
    };
  }
  if (actions.includes('resume') && worktree.latestSessionId !== undefined) {
    const sessionId = worktree.latestSessionId;
    return {
      run: () => onResume(sessionId, directoryPath),
      title: `Resume the latest conversation in ${worktree.branch}`,
      testId: 'worktree-resume',
    };
  }
  return null;
}
