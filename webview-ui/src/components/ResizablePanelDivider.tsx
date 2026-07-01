import { useCallback } from 'react';

import { DETAIL_PANEL_MAX_HEIGHT_RATIO, DETAIL_PANEL_MIN_HEIGHT } from '../constants.js';

interface ResizablePanelDividerProps {
  height: number;
  onHeightChange: (h: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * Draggable bar between the office canvas and the AgentDetailPanel. Dragging
 * resizes the panel (clamped to [MIN, viewport * MAX_RATIO]); the button toggles
 * the panel collapsed/expanded. When collapsed the bar stays visible (so the
 * panel can be reopened) but drag is disabled.
 */
export function ResizablePanelDivider({
  height,
  onHeightChange,
  collapsed,
  onToggleCollapse,
}: ResizablePanelDividerProps) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = height;
      const max = window.innerHeight * DETAIL_PANEL_MAX_HEIGHT_RATIO;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          max,
          Math.max(DETAIL_PANEL_MIN_HEIGHT, startH + (startY - ev.clientY)),
        );
        onHeightChange(next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [height, onHeightChange],
  );

  return (
    <div
      data-testid="detail-panel-divider"
      onMouseDown={collapsed ? undefined : onMouseDown}
      className="flex items-center justify-end shrink-0 bg-bg-dark border-t-2 border-border select-none"
      style={{ height: 10, cursor: collapsed ? 'default' : 'ns-resize' }}
    >
      <button
        data-testid="detail-panel-collapse"
        onClick={onToggleCollapse}
        title={collapsed ? 'Show agent panel' : 'Hide agent panel'}
        className="h-full px-8 border-0 bg-btn-bg text-text-muted text-2xs leading-none cursor-pointer font-pixel"
      >
        {collapsed ? '▲' : '▼'}
      </button>
    </div>
  );
}
