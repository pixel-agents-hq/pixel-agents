import type { AgentTask } from '../../../core/src/messages.js';
import {
  TASK_BOARD_BOTTOM_CLEARANCE_PX,
  TASK_BOARD_MARGIN_PX,
  TASK_BOARD_STATUS_ORDER,
  TASK_BOARD_TOOLTIP_CLEARANCE_PX,
} from '../constants.js';

interface TaskBoardProps {
  /** Per-agent task lists. Agents without a board are absent, not empty. */
  agentTasks: Record<number, AgentTask[]>;
  selectedAgent: number | null;
  /** Same action as clicking the agent's character: focus its terminal. */
  onFocusAgent: (id: number) => void;
  /** True while the first-run hooks tooltip holds the top-right corner. The
   *  board drops below it rather than under it — the two rarely coincide (the
   *  tooltip is dismissed long before an agent publishes a list), but when they
   *  do, the board is the half that would be unreadable. */
  belowTooltip: boolean;
}

/** Marker column per status. Text, not sprites — the board is DOM, not canvas. */
const STATUS_MARKER: Record<AgentTask['status'], string> = {
  in_progress: '>',
  pending: '-',
  completed: 'x',
};

const STATUS_TEXT_CLASS: Record<AgentTask['status'], string> = {
  in_progress: 'text-status-active',
  pending: 'text-text-muted',
  completed: 'text-status-success line-through opacity-50',
};

/**
 * Live task list per agent, beside the office.
 *
 * The office says what an agent is touching right now; this says what it is
 * working through. Tasks are grouped by status rather than left in the agent's
 * own order, because the board is glanced at and the in-progress row is the
 * reason to glance. Within a status the agent's order is preserved.
 */
export function TaskBoard({
  agentTasks,
  selectedAgent,
  onFocusAgent,
  belowTooltip,
}: TaskBoardProps) {
  const boards = Object.entries(agentTasks)
    .map(([id, tasks]) => ({ id: Number(id), tasks }))
    .sort((a, b) => a.id - b.id);

  // No agent has published a list — show nothing rather than an empty frame.
  if (boards.length === 0) return null;

  return (
    <div
      className="absolute right-8 z-10 flex flex-col gap-4 w-[320px] overflow-y-auto"
      style={{
        top: belowTooltip ? TASK_BOARD_TOOLTIP_CLEARANCE_PX : TASK_BOARD_MARGIN_PX,
        maxHeight: `calc(100% - ${(belowTooltip ? TASK_BOARD_TOOLTIP_CLEARANCE_PX : TASK_BOARD_MARGIN_PX) + TASK_BOARD_BOTTOM_CLEARANCE_PX}px)`,
      }}
    >
      {boards.map(({ id, tasks }) => (
        <div
          key={id}
          className={`pixel-panel p-8 text-xs select-none cursor-pointer ${
            id === selectedAgent ? 'border-accent-bright!' : ''
          }`}
          onClick={() => onFocusAgent(id)}
        >
          <div className="flex justify-between items-baseline gap-4 mb-4">
            <span className="truncate">Agent {id}</span>
            <span className="text-text-muted shrink-0">
              {tasks.filter((t) => t.status === 'completed').length}/{tasks.length}
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {TASK_BOARD_STATUS_ORDER.flatMap((status) =>
              tasks
                .filter((task) => task.status === status)
                .map((task, i) => (
                  <li key={`${status}-${i}`} className={`flex gap-4 ${STATUS_TEXT_CLASS[status]}`}>
                    <span aria-hidden="true" className="shrink-0">
                      {STATUS_MARKER[status]}
                    </span>
                    {/* activeForm is the agent's present-tense phrasing, and
                        only reads correctly while the task is running. */}
                    <span>
                      {status === 'in_progress' && task.activeForm ? task.activeForm : task.content}
                    </span>
                  </li>
                )),
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}
