import type { KeyboardEvent } from 'react';
import { useEffect, useState } from 'react';

import type { Directory } from '../hooks/useExtensionMessages.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

export interface DirectoryModalValues {
  name: string;
  path: string;
  /** Areas this Directory's future agents should be seated in. */
  areas: string[];
}

interface DirectoryModalProps {
  isOpen: boolean;
  /** The Directory being edited, or null when adding a new one. */
  editing: Directory | null;
  /** Why the last save was refused, shown inline. Cleared by the surface when
   *  the modal opens or a new save is sent. */
  error: string | null;
  /** Paths recovered from past sessions; tapping one fills the path field. Empty
   *  (a fresh machine, or everything already a Directory) renders no section. */
  suggestions: string[];
  /** Area labels the office layout defines. Empty renders no section. */
  areas: string[];
  /** Areas already mapped to the Directory being edited. */
  assignedAreas: string[];
  onSubmit: (values: DirectoryModalValues) => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * Define a launch target from inside the office: a name, a filesystem path,
 * and which Areas its agents belong in.
 *
 * The path is free text (a leading `~` is expanded host-side) and is validated
 * where the filesystem is — the host. This modal never guesses: it sends, then
 * waits. A rebroadcast Directory list means saved (the surface closes the
 * modal); `error` means refused, with nothing persisted.
 *
 * Typing an absolute path on a phone is the worst part of that flow, which is
 * what the suggestion list is for: the host offers directories agents have
 * already run in, and a tap fills the field — it does NOT save, so the name and
 * the Areas can still be set before committing.
 */
export function DirectoryModal({
  isOpen,
  editing,
  error,
  suggestions,
  areas,
  assignedAreas,
  onSubmit,
  onDelete,
  onClose,
}: DirectoryModalProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [selectedAreas, setSelectedAreas] = useState<string[]>([]);

  // Refill from whatever the modal was opened on. Keyed on isOpen too, so
  // re-opening Add after a cancelled edit starts blank rather than stale.
  useEffect(() => {
    if (!isOpen) return;
    setName(editing?.name ?? '');
    setPath(editing?.path ?? '');
    setSelectedAreas(assignedAreas);
    // assignedAreas is derived per render; keying the refill on it would reset
    // the multi-select on every keystroke. Opening the modal is the only moment
    // it should be read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editing]);

  if (!isOpen) return null;

  const submit = () => {
    onSubmit({ name: name.trim(), path: path.trim(), areas: selectedAreas });
  };

  const toggleArea = (label: string) => {
    setSelectedAreas((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  };

  // Scoped to the modal rather than the document: the office's own key handling
  // (Esc exits the layout editor) must not see these.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.stopPropagation();
      submit();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Edit Directory' : 'Add Directory'}
      // Wider minimum than Modal's so path suggestions get room, still
      // yielding via min() on narrow screens — a phone gets the full width
      // (minus Modal's margin padding), a desktop only this floor.
      className="min-w-[min(420px,100%)]!"
    >
      <div
        data-testid="directory-modal"
        className="flex flex-col gap-8 px-10 py-4"
        onKeyDown={handleKeyDown}
      >
        <label className="flex flex-col gap-2 text-xs text-text-muted">
          Name
          <input
            type="text"
            value={name}
            autoFocus
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            className="text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
        </label>
        <label className="flex flex-col gap-2 text-xs text-text-muted">
          Path
          <input
            type="text"
            value={path}
            placeholder="~/code/my-project"
            onChange={(e) => setPath(e.target.value)}
            className="text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
        </label>
        {suggestions.length > 0 && (
          <div data-testid="directory-suggestions" className="flex flex-col gap-2">
            <span className="text-xs text-text-muted">Recent working directories</span>
            <div className="flex flex-col max-h-160 overflow-y-auto pixel-scrollbar">
              {suggestions.map((suggestion) => (
                // shrink-0 is what keeps the list scrollable rather than
                // invisible: overflow-hidden zeroes a flex item's automatic
                // minimum size, so without it the column crushes every row
                // into the max-height instead of overflowing.
                <button
                  key={suggestion}
                  onClick={() => setPath(suggestion)}
                  title={suggestion}
                  className="shrink-0 text-sm text-left py-4 px-4 bg-transparent border-none rounded-none cursor-pointer text-text-muted hover:text-text hover:bg-btn-bg overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {areas.length > 0 && (
          <div data-testid="directory-areas" className="flex flex-col gap-2">
            {/* The same Directory→Area mapping the layout editor writes: agents
                launched here prefer seats inside the Areas ticked below. */}
            <span className="text-xs text-text-muted">Areas</span>
            <div className="flex flex-wrap gap-4">
              {areas.map((label) => {
                const selected = selectedAreas.includes(label);
                return (
                  <button
                    key={label}
                    onClick={() => toggleArea(label)}
                    aria-pressed={selected}
                    className={`text-sm py-2 px-4 border-2 rounded-none cursor-pointer ${
                      selected
                        ? 'bg-accent border-accent text-text'
                        : 'bg-transparent border-border text-text-muted hover:text-text'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {error !== null && (
          <div role="alert" className="text-xs text-danger">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-8 pt-4">
          {/* Deleting a Directory is bookkeeping only: agents already running in
              it keep running, so this needs no confirmation step. */}
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
