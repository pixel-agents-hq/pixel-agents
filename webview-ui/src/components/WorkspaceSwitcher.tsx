import type { CSSProperties } from 'react';

import type { Workspace, WorkspaceBadge } from '../workspaces.js';
import { switcherTouchTargetStyle, workspaceTabLabel } from '../workspaces.js';
import { Button } from './ui/Button.js';

interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /** Attention counts per Workspace; the active one has none by construction. */
  badges: Record<string, WorkspaceBadge>;
  /** Show the `+` tab (false for a read-only office). */
  canCreate: boolean;
  /** Show the pencil on the active tab (false for a read-only office). */
  canEdit: (workspaceId: string) => boolean;
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  onEdit: (workspace: Workspace) => void;
  /** Finger-sized controls and a horizontally scrollable row (the phone shell). */
  touchTargets?: boolean;
  className?: string;
  style?: CSSProperties;
}

const BADGE_BASE = 'text-bg-dark text-2xs leading-none px-3 py-1 border-2 border-bg-dark';

/**
 * One row of Workspace tabs with a trailing `+`: the office shows the pressed
 * tab's agents only. Other tabs carry what is waiting on the user there — a
 * yellow `!n` for permission requests, a green `n` for finished turns — so the
 * count is told apart by its mark and its colour, and spoken in the tab's
 * aria-label.
 *
 * The row scrolls sideways rather than wrapping, so any number of Workspaces
 * keeps a one-line strip. The pencil appears only beside the active tab: editing
 * and deleting both live in the modal it opens.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  badges,
  canCreate,
  canEdit,
  onSelect,
  onCreate,
  onEdit,
  touchTargets = false,
  className = '',
  style,
}: WorkspaceSwitcherProps) {
  const targetStyle = switcherTouchTargetStyle(touchTargets);

  return (
    <div
      role="tablist"
      aria-label="Workspaces"
      data-testid="workspace-switcher"
      className={`flex items-center gap-4 overflow-x-auto no-scrollbar touch-pan-x ${className}`}
      style={style}
    >
      {workspaces.map((workspace) => {
        const active = workspace.id === activeWorkspaceId;
        const badge = badges[workspace.id];
        return (
          <div key={workspace.id} className="flex items-center gap-2 shrink-0">
            <Button
              role="tab"
              aria-selected={active}
              aria-label={workspaceTabLabel(workspace.name, badge)}
              data-testid="workspace-tab"
              variant={active ? 'active' : 'default'}
              size="sm"
              className="border-border! shadow-pixel whitespace-nowrap flex items-center gap-4 py-4"
              style={targetStyle}
              onClick={() => onSelect(workspace.id)}
            >
              <span>{workspace.name}</span>
              {badge && badge.permission > 0 && (
                <span aria-hidden="true" className={`${BADGE_BASE} bg-status-permission`}>
                  !{badge.permission}
                </span>
              )}
              {badge && badge.waiting > 0 && (
                <span aria-hidden="true" className={`${BADGE_BASE} bg-status-success`}>
                  {badge.waiting}
                </span>
              )}
            </Button>
            {active && canEdit(workspace.id) && (
              <Button
                variant="default"
                size="sm"
                aria-label={`Edit ${workspace.name}`}
                title="Edit workspace"
                className="border-border! shadow-pixel flex items-center justify-center py-4"
                style={targetStyle}
                onClick={() => onEdit(workspace)}
              >
                <span className="material-symbols-sharp text-[12px]" aria-hidden="true">
                  edit
                </span>
              </Button>
            )}
          </div>
        );
      })}
      {canCreate && (
        <Button
          variant="default"
          size="sm"
          aria-label="New workspace"
          title="New workspace"
          data-testid="workspace-add"
          className="border-border! shadow-pixel shrink-0 flex items-center justify-center py-4"
          style={targetStyle}
          onClick={onCreate}
        >
          +
        </Button>
      )}
    </div>
  );
}
