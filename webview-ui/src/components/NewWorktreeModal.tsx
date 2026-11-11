import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  WorktreeBranch,
  WorktreeBranchLocation,
  WorktreeOptions,
} from '../../../core/src/messages.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import {
  branchKey,
  filterBranches,
  initialLocations,
  newWorktreeNameProblem,
  offeredLocations,
  orderedBranches,
  sameBranch,
  toggleLocation,
} from '../worktrees/newWorktree.js';
import type { WorktreeChoices } from '../worktrees/useNewWorktree.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';
import { PixelIcon } from './ui/PixelIcon.js';

/**
 * A new Worktree, before its agent launches: its name (a generated one to
 * keep or change; the branch is the Directory's prefix + it) and the branch
 * it starts from — the repo's local branches and origin's, the Directory's
 * base setting picked to begin with. Opened by a drawer row's worktree
 * button; mounted at App's top level, so both shells show it.
 */
export function NewWorktreeModal({
  directory,
  options,
  onSubmit,
  onClose,
}: {
  /** The Directory it is for; null = closed. */
  directory: Directory | null;
  /** null while the server is reading the repo. */
  options: WorktreeOptions | null;
  onSubmit: (choices: WorktreeChoices) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen={directory !== null}
      onClose={onClose}
      title={directory ? `New worktree in ${directory.name}` : 'New worktree'}
      className="w-[min(420px,100%)]"
    >
      {options ? (
        <NewWorktreeForm
          key={options.directoryPath}
          options={options}
          onSubmit={onSubmit}
          onClose={onClose}
        />
      ) : (
        <div data-testid="new-worktree-loading" className="px-10 py-8 text-sm text-text-muted">
          Reading branches…
        </div>
      )}
    </Modal>
  );
}

function NewWorktreeForm({
  options,
  onSubmit,
  onClose,
}: {
  options: WorktreeOptions;
  onSubmit: (choices: WorktreeChoices) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(options.name);
  const [filter, setFilter] = useState('');
  // null = the current commit (a detached checkout, which has no branch).
  const [from, setFrom] = useState<WorktreeBranch | null>(options.defaultBase ?? null);
  const [locations, setLocations] = useState(() => initialLocations(options));
  const [tried, setTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const branches = useMemo(() => orderedBranches(options), [options]);
  const shown = useMemo(
    () => filterBranches(branches, filter, locations),
    [branches, filter, locations],
  );
  const bothOffered = offeredLocations(options).length > 1;
  const trimmed = name.trim();
  const problem = newWorktreeNameProblem(trimmed, options);
  const detached = options.defaultBase === undefined;

  const submit = () => {
    setTried(true);
    if (problem) return;
    onSubmit({ name: trimmed, ...(from ? { from } : {}) });
  };

  return (
    <div
      data-testid="new-worktree-modal"
      className="flex flex-col gap-8 px-10 py-4"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <label className="flex flex-col gap-2 text-xs text-text-muted">
        Name
        <input
          ref={nameRef}
          data-testid="new-worktree-name"
          type="text"
          value={name}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setName(e.target.value)}
          className="text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
        />
      </label>
      {tried && problem ? (
        <span role="alert" className="text-xs text-danger -mt-4">
          {problem}
        </span>
      ) : (
        <span
          data-testid="new-worktree-branch"
          className="flex items-center gap-4 text-xs text-text-muted -mt-4 min-w-0"
        >
          <PixelIcon name="worktree" scale={1} />
          <span className="truncate" title={`${options.prefix}${trimmed}`}>
            {options.prefix}
            {trimmed || '…'}
          </span>
        </span>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-8">
          <span className="text-xs text-text-muted">Start from</span>
          {/* Which branches are listed: each chip shows or hides its own;
              both may be on, never neither. */}
          {bothOffered && (
            <span className="flex gap-4" role="group" aria-label="Branches shown">
              {(['local', 'origin'] as const).map((location) => (
                <LocationChip
                  key={location}
                  location={location}
                  pressed={locations.includes(location)}
                  onToggle={() => setLocations((prev) => toggleLocation(prev, location))}
                />
              ))}
            </span>
          )}
        </div>
        <input
          data-testid="new-worktree-filter"
          type="text"
          value={filter}
          placeholder="Filter branches"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setFilter(e.target.value)}
          className="text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
        />
        <div
          role="radiogroup"
          aria-label="Start from"
          data-testid="new-worktree-branches"
          className="flex flex-col max-h-200 overflow-y-auto pixel-scrollbar border-2 border-border"
        >
          {detached && filter.trim() === '' && (
            <BranchRow
              label="Current commit"
              tag="detached"
              selected={from === null}
              onSelect={() => setFrom(null)}
            />
          )}
          {shown.map((branch) => (
            <BranchRow
              key={branchKey(branch)}
              label={branch.name}
              tag={branch.location}
              note={branch.current ? 'current' : undefined}
              selected={sameBranch(from ?? undefined, branch)}
              onSelect={() => setFrom(branch)}
            />
          ))}
          {shown.length === 0 && (
            <span className="text-sm text-text-muted py-4 px-4">No branch matches.</span>
          )}
        </div>
        {from?.location === 'origin' && (
          <span className="text-2xs text-text-muted leading-tight">
            Origin is fetched first, so it starts from the latest {from.name}.
          </span>
        )}
      </div>

      <div className="flex items-center justify-end gap-8 pt-4">
        <Button variant="default" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="accent" size="sm" data-testid="new-worktree-launch" onClick={submit}>
          Launch
        </Button>
      </div>
    </div>
  );
}

function LocationChip({
  location,
  pressed,
  onToggle,
}: {
  location: WorktreeBranchLocation;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={`new-worktree-show-${location}`}
      title={pressed ? `Hide ${location} branches` : `Show ${location} branches`}
      onClick={onToggle}
      className={`text-2xs py-1 px-6 border-2 rounded-none cursor-pointer ${
        pressed
          ? 'bg-active-bg border-accent text-text'
          : 'bg-transparent border-border text-text-muted hover:text-text'
      }`}
    >
      {location}
    </button>
  );
}

function BranchRow({
  label,
  tag,
  note,
  selected,
  onSelect,
}: {
  label: string;
  tag: string;
  note?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid="new-worktree-base"
      data-branch={`${tag}:${label}`}
      onClick={onSelect}
      className={`shrink-0 flex items-center gap-8 text-sm text-left py-4 px-6 border-none rounded-none cursor-pointer ${
        selected
          ? 'bg-active-bg text-text'
          : 'bg-transparent text-text-muted hover:text-text hover:bg-btn-bg'
      }`}
    >
      <span className="flex-1 min-w-0 truncate" title={label}>
        {label}
      </span>
      {note && <span className="shrink-0 text-2xs text-text-muted">{note}</span>}
      <span className="shrink-0 w-52 text-center text-2xs border-2 border-border text-text-muted">
        {tag}
      </span>
    </button>
  );
}
