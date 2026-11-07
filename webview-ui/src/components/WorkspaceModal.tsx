import type { KeyboardEvent } from 'react';
import { useEffect, useState } from 'react';

import type { Directory } from '../hooks/useExtensionMessages.js';
import type { Workspace } from '../workspaces.js';
import { directoryPathKey, workspaceOwningDirectory, workspacePathsToSave } from '../workspaces.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

export interface WorkspaceModalValues {
  name: string;
  directoryPaths: string[];
}

interface WorkspaceModalProps {
  isOpen: boolean;
  /** The Workspace being edited, or null when creating one. */
  editing: Workspace | null;
  /** Every Workspace, to tell which Directories another one already owns. */
  workspaces: Workspace[];
  /** Every Directory the office knows, whichever Workspace owns it. */
  directories: Directory[];
  /** Why the last write was refused, shown inline. */
  error: string | null;
  onSubmit: (values: WorkspaceModalValues) => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * Create or edit a Workspace: a name and the Directories it groups.
 *
 * A Directory belongs to at most one Workspace, so one that another Workspace
 * owns is shown disabled and tagged `In <name>` rather than hidden — the user
 * sees why it cannot be ticked. Like the Directory modal this never guesses at
 * the outcome: it sends, then waits; the server's refusal (`error`) appears
 * here and its rebroadcast list closes the modal.
 *
 * Deleting is bookkeeping only: the Workspace's Directories and agents return
 * to the default Workspace and keep running, so it needs no confirmation.
 */
export function WorkspaceModal({
  isOpen,
  editing,
  workspaces,
  directories,
  error,
  onSubmit,
  onDelete,
  onClose,
}: WorkspaceModalProps) {
  const [name, setName] = useState('');
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);

  // Refill from whatever the modal was opened on, so re-opening Create after a
  // cancelled edit starts blank rather than stale.
  useEffect(() => {
    if (!isOpen) return;
    setName(editing?.name ?? '');
    setCheckedKeys((editing?.directoryPaths ?? []).map(directoryPathKey));
  }, [isOpen, editing]);

  if (!isOpen) return null;

  const submit = () => {
    const checkedPaths = directories
      .filter((directory) => checkedKeys.includes(directoryPathKey(directory.path)))
      .map((directory) => directory.path);
    onSubmit({
      name: name.trim(),
      directoryPaths: workspacePathsToSave(
        checkedPaths,
        directories.map((directory) => directory.path),
        editing?.directoryPaths ?? [],
      ),
    });
  };

  const toggle = (path: string) => {
    const key = directoryPathKey(path);
    setCheckedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  // Scoped to the modal rather than the document: the office's own key handling
  // (Esc exits the layout editor) must not see these.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (
      e.key === 'Enter' &&
      e.target instanceof HTMLInputElement &&
      e.target.type === 'text'
    ) {
      e.stopPropagation();
      e.preventDefault();
      submit();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Edit Workspace' : 'Add Workspace'}
      className="min-w-[min(420px,100%)]!"
    >
      <div
        data-testid="workspace-modal"
        className="flex flex-col gap-8 px-10 py-4"
        onKeyDown={handleKeyDown}
      >
        <label className="flex flex-col gap-2 text-xs text-text-muted">
          Name
          <input
            type="text"
            value={name}
            autoFocus
            placeholder="Workspace name"
            onChange={(e) => setName(e.target.value)}
            className="text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-text-muted">Directories</span>
          {directories.length === 0 ? (
            <span className="text-sm text-text-muted">No directories yet</span>
          ) : (
            <div
              data-testid="workspace-directories"
              className="flex flex-col max-h-160 overflow-y-auto pixel-scrollbar"
            >
              {directories.map((directory) => {
                const owner = workspaceOwningDirectory(workspaces, directory.path);
                const takenElsewhere = owner !== undefined && owner.id !== editing?.id;
                const checked = checkedKeys.includes(directoryPathKey(directory.path));
                return (
                  <label
                    key={directory.path}
                    title={directory.path}
                    className={`shrink-0 flex items-center gap-8 py-4 px-4 text-sm ${
                      takenElsewhere
                        ? 'text-text-muted cursor-default'
                        : 'text-text cursor-pointer hover:bg-btn-bg'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked && !takenElsewhere}
                      disabled={takenElsewhere}
                      onChange={() => toggle(directory.path)}
                      className="shrink-0 accent-accent"
                    />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {directory.name}
                    </span>
                    {takenElsewhere && (
                      <span className="shrink-0 text-2xs text-text-muted border-2 border-border pl-4 pr-2 leading-none">
                        In {owner.name}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
        {error !== null && (
          <div role="alert" className="text-xs text-danger">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-8 pt-4">
          {editing ? (
            <Button variant="ghost" size="sm" className="text-danger!" onClick={onDelete}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-8">
            <Button variant="default" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="accent" size="sm" onClick={submit}>
              Save
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
