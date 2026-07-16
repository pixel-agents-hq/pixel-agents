import { useEffect, useRef, useState } from 'react';

import { FLOOR_DELETE_CONFIRM_TIMEOUT_MS, FLOOR_NAME_MAX_LENGTH } from '../constants.js';
import { Button } from './ui/Button.js';

interface FloorSwitcherProps {
  floors: Array<{ id: string; name: string }>;
  activeFloorId: string;
  isEditMode: boolean;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Elevator-style floor list, top-left. Hidden entirely for a single-floor
 * office outside edit mode (the pre-multi-floor look). Floors display like a
 * building: first floor at the bottom, newest on top.
 *
 * Edit mode adds: "+ Floor", rename (double-click a tab), delete (× with a
 * two-step confirm that auto-disarms).
 */
export function FloorSwitcher({
  floors,
  activeFloorId,
  isEditMode,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
}: FloorSwitcherProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Auto-disarm the delete confirm
  useEffect(() => {
    if (armedDeleteId === null) return;
    if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
    disarmTimerRef.current = setTimeout(
      () => setArmedDeleteId(null),
      FLOOR_DELETE_CONFIRM_TIMEOUT_MS,
    );
    return () => {
      if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
    };
  }, [armedDeleteId]);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.select();
  }, [renamingId]);

  // Leaving edit mode cancels any in-progress rename/delete confirm
  useEffect(() => {
    if (!isEditMode) {
      setRenamingId(null);
      setArmedDeleteId(null);
    }
  }, [isEditMode]);

  if (floors.length <= 1 && !isEditMode) return null;

  const commitRename = () => {
    if (renamingId !== null) {
      onRename(renamingId, renameDraft);
    }
    setRenamingId(null);
  };

  // Building order: newest floor on top, first floor at the bottom
  const displayFloors = [...floors].reverse();

  return (
    <div
      className="absolute top-10 left-10 z-20 flex flex-col gap-4 pixel-panel p-4"
      data-testid="floor-switcher"
    >
      {isEditMode && (
        <Button
          variant="accent"
          size="sm"
          onClick={onAdd}
          data-testid="floor-add"
          title="Add floor"
        >
          + Floor
        </Button>
      )}
      {displayFloors.map((floor) => {
        const isActive = floor.id === activeFloorId;
        if (renamingId === floor.id) {
          return (
            <input
              key={floor.id}
              ref={renameInputRef}
              className="bg-btn-bg text-text border-2 border-accent rounded-none py-1 px-4 text-sm w-full min-w-0"
              value={renameDraft}
              maxLength={FLOOR_NAME_MAX_LENGTH}
              data-testid={`floor-rename-input-${floor.id}`}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingId(null);
                e.stopPropagation();
              }}
            />
          );
        }
        return (
          <div key={floor.id} className="flex items-center gap-2">
            <Button
              variant={isActive ? 'active' : 'default'}
              size="sm"
              className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap max-w-160"
              data-testid={`floor-tab-${floor.id}`}
              title={
                isEditMode ? `${floor.name} — double-click to rename` : `Switch to ${floor.name}`
              }
              onClick={() => onSwitch(floor.id)}
              onDoubleClick={() => {
                if (!isEditMode) return;
                setRenameDraft(floor.name);
                setRenamingId(floor.id);
              }}
            >
              {floor.name}
            </Button>
            {isEditMode && floors.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className={armedDeleteId === floor.id ? 'text-warning' : ''}
                data-testid={`floor-delete-${floor.id}`}
                title={armedDeleteId === floor.id ? 'Click again to delete' : 'Delete floor'}
                onClick={() => {
                  if (armedDeleteId === floor.id) {
                    setArmedDeleteId(null);
                    onDelete(floor.id);
                  } else {
                    setArmedDeleteId(floor.id);
                  }
                }}
              >
                {armedDeleteId === floor.id ? '!' : '×'}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
