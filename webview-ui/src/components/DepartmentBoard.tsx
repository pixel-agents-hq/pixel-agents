import { useEffect, useRef, useState } from 'react';

import type { DepartmentBoardData, DepartmentBoardEntry } from '../office/departmentBoard.js';

interface DepartmentBoardProps {
  isOpen: boolean;
  floorId: string;
  floorName: string;
  data: DepartmentBoardData;
  notes: string;
  onNotesChange: (floorId: string, notes: string) => void;
  onRenameAgent: (id: number, name: string) => void;
}

interface SectionProps {
  title: string;
  entries: DepartmentBoardEntry[];
  emptyText: string;
  dotColor?: string;
  testId: string;
  onRenameAgent?: (id: number, name: string) => void;
}

/** One staff row's label: a static span, or (renamable sections only) an
 *  editable name swapped in on double-click. Enter/blur commits, Escape
 *  cancels. */
function EntryLabel({
  entry,
  onRenameAgent,
}: {
  entry: DepartmentBoardEntry;
  onRenameAgent?: (id: number, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.label);

  if (!onRenameAgent) {
    return (
      <span className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{entry.label}</span>
    );
  }

  if (editing) {
    return (
      <input
        autoFocus
        data-testid={`board-entry-name-input-${entry.id}`}
        className="text-sm bg-btn-bg text-text border-2 border-border rounded-none px-2 py-0 w-full min-w-0"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          onRenameAgent(entry.id, draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setEditing(false);
            onRenameAgent(entry.id, draft);
          } else if (e.key === 'Escape') {
            setDraft(entry.label);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <span
      className="text-sm overflow-hidden text-ellipsis whitespace-nowrap cursor-text"
      title="Double-click to rename"
      data-testid={`board-entry-name-${entry.id}`}
      onDoubleClick={() => {
        setDraft(entry.label);
        setEditing(true);
      }}
    >
      {entry.label}
    </span>
  );
}

function Section({ title, entries, emptyText, dotColor, testId, onRenameAgent }: SectionProps) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="text-sm text-text-muted">
        {title} ({entries.length})
      </div>
      {entries.length === 0 ? (
        <div className="text-2xs text-text-muted italic">{emptyText}</div>
      ) : (
        <ul className="flex flex-col gap-2 m-0 pl-0 list-none">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-4 overflow-hidden"
              data-testid={`board-entry-${entry.id}`}
            >
              {dotColor && (
                <span className="w-6 h-6 rounded-full shrink-0" style={{ background: dotColor }} />
              )}
              <EntryLabel entry={entry} onRenameAgent={onRenameAgent} />
              <span className="text-2xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">
                {entry.statusText}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Per-floor department board: a live roster (staff / help wanted / open
 * items, derived from officeState + agentTools by departmentBoard.ts) plus a
 * manual free-text notes field, persisted per floor. Toggled from the
 * BottomToolbar "Board" button; hidden entirely when isOpen is false.
 */
export function DepartmentBoard({
  isOpen,
  floorId,
  floorName,
  data,
  notes,
  onNotesChange,
  onRenameAgent,
}: DepartmentBoardProps) {
  const [draft, setDraft] = useState(notes);
  const lastFloorId = useRef(floorId);

  // Only reset the local draft when the VIEWED floor changes — not on every
  // notes prop update, which would otherwise clobber in-progress typing when
  // a re-render happens to carry the same-but-object-identity-different notes.
  useEffect(() => {
    if (lastFloorId.current !== floorId) {
      lastFloorId.current = floorId;
      setDraft(notes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorId]);

  if (!isOpen) return null;

  return (
    <div
      className="absolute top-10 right-10 z-20 pixel-panel p-4 flex flex-col gap-8 w-224 max-h-[calc(100vh-20px)] overflow-y-auto"
      data-testid="department-board"
    >
      <div className="text-sm font-bold overflow-hidden text-ellipsis whitespace-nowrap">
        {floorName}
      </div>

      <Section
        title="Staff"
        entries={data.staff}
        emptyText="No one seated here yet"
        testId="board-staff"
        onRenameAgent={onRenameAgent}
      />
      <Section
        title="Help Wanted"
        entries={data.helpWanted}
        emptyText="No one needs approval"
        dotColor="var(--color-status-permission)"
        testId="board-help-wanted"
      />
      <Section
        title="Open Items"
        entries={data.openItems}
        emptyText="Nothing running"
        dotColor="var(--color-status-active)"
        testId="board-open-items"
      />

      <div className="flex flex-col gap-2">
        <div className="text-sm text-text-muted">Notes</div>
        <textarea
          data-testid="board-notes"
          className="bg-btn-bg text-text border-2 border-border rounded-none p-6 text-sm w-full resize-none"
          rows={4}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onNotesChange(floorId, e.target.value);
          }}
          placeholder="Notes for this floor..."
        />
      </div>
    </div>
  );
}
