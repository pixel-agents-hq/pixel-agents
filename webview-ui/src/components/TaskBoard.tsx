import type { AgentTask } from '../../../core/src/messages.js';
import {
  TASK_BOARD_BOTTOM_CLEARANCE_PX,
  TASK_BOARD_MARGIN_PX,
  TASK_BOARD_STATUS_ORDER,
  TASK_BOARD_TOOLTIP_CLEARANCE_PX,
} from '../constants.js';
import { Button } from './ui/Button.js';

interface TaskBoardProps {
  /** Per-agent task lists. Agents without a board are absent, not empty. */
  agentTasks: Record<number, AgentTask[]>;
  /** The selected agent, and the only thing that decides which board shows. */
  selectedAgent: number | null;
  /** Select an agent from the board side: highlights its character, follows it
   *  with the camera, and focuses its terminal — the same outcome as clicking
   *  the character itself, so the two never disagree about who is selected. */
  onSelectAgent: (id: number) => void;
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
 * Live task list for the selected agent, beside the office.
 *
 * The office says what an agent is touching right now; this says what it is
 * working through. Tasks are grouped by status rather than left in the agent's
 * own order, because the board is glanced at and the in-progress row is the
 * reason to glance. Within a status the agent's order is preserved.
 *
 * **Selection is the only input.** The board shows the selected agent's list
 * and nothing else, and the tab strip selects rather than keeping a second
 * pointer of its own. An earlier version tracked its own "active tab" beside
 * the office selection, and the two drifted apart the moment either side
 * changed — picking an agent on the canvas left the board on someone else.
 *
 * With nothing selected the strip falls back to the first board, so opening
 * the panel cold still shows something. Once an agent IS selected the board
 * follows it strictly, and an agent with no list shows no board — but the tab
 * strip stays, because it is the only way back to a board from there. Hiding
 * it too would strand the user: selecting a boardless agent would empty the
 * panel with no control left to undo it.
 */
export function TaskBoard({
  agentTasks,
  selectedAgent,
  onSelectAgent,
  belowTooltip,
}: TaskBoardProps) {
  const boards = Object.entries(agentTasks)
    .map(([id, tasks]) => ({ id: Number(id), tasks }))
    .sort((a, b) => a.id - b.id);

  // No agent has published a list — show nothing rather than an empty frame.
  if (boards.length === 0) return null;

  // A selected agent with no board shows NO board: leaving the previous agent's
  // list up under a different selection would misattribute whose work it is.
  // `null` here is that state, distinct from "nothing is selected", which falls
  // back to the first board.
  const active =
    selectedAgent !== null
      ? (boards.find((b) => b.id === selectedAgent) ?? null)
      : (boards[0] ?? null);

  // The strip is normally redundant with a single board, but it is the only
  // control that can restore a hidden one — so it appears whenever no board is
  // showing, however few there are.
  const showTabs = boards.length > 1 || active === null;
  const topPx = belowTooltip ? TASK_BOARD_TOOLTIP_CLEARANCE_PX : TASK_BOARD_MARGIN_PX;

  return (
    <div
      data-testid="task-board"
      className="absolute right-8 z-10 flex flex-col gap-4 w-[320px]"
      style={{
        top: topPx,
        maxHeight: `calc(100% - ${topPx + TASK_BOARD_BOTTOM_CLEARANCE_PX}px)`,
      }}
    >
      {showTabs && (
        <div
          data-testid="task-board-tabs"
          // Scrolls rather than wraps: a wrapped strip grows downward and eats
          // the space the board itself needs, which is the problem this replaced.
          className="flex gap-2 overflow-x-auto shrink-0"
        >
          {boards.map(({ id, tasks }) => {
            // No tab reads as active while no board is showing — marking one
            // would point at a panel that is not there.
            const isActive = id === active?.id;
            return (
              <Button
                key={id}
                size="sm"
                variant={isActive ? 'active' : 'default'}
                data-testid="task-board-tab"
                data-agent-id={id}
                data-active={isActive || undefined}
                className="shrink-0 whitespace-nowrap"
                onClick={() => onSelectAgent(id)}
              >
                Agent {id}
                {/* Only one board is visible, so the strip carries the one thing
                    the hidden boards were worth glancing at: whether that agent
                    is running something. */}
                {tasks.some((t) => t.status === 'in_progress') && (
                  <span aria-hidden="true" className="text-status-active ml-4">
                    •
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}

      {active && (
        <div
          data-testid="task-board-agent"
          data-agent-id={active.id}
          className={`pixel-panel p-8 text-xs select-none cursor-pointer overflow-y-auto ${
            active.id === selectedAgent ? 'border-accent-bright!' : ''
          }`}
          onClick={() => onSelectAgent(active.id)}
        >
          <div className="flex justify-between items-baseline gap-4 mb-4">
            <span className="truncate">Agent {active.id}</span>
            <span data-testid="task-board-progress" className="text-text-muted shrink-0">
              {active.tasks.filter((t) => t.status === 'completed').length}/{active.tasks.length}
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {TASK_BOARD_STATUS_ORDER.flatMap((status) =>
              active.tasks
                .filter((task) => task.status === status)
                .map((task, i) => (
                  <li
                    key={`${status}-${i}`}
                    data-testid="task-board-task"
                    data-status={status}
                    className={`flex gap-4 ${STATUS_TEXT_CLASS[status]}`}
                  >
                    <span aria-hidden="true" className="shrink-0">
                      {STATUS_MARKER[status]}
                    </span>
                    {/* activeForm is the agent's present-tense phrasing, and
                      only reads correctly while the task is running.
                      `min-w-0 break-words`: a flex child will not shrink below
                      its content width, so one long unbroken token — a URL, a
                      path, an identifier, all plausible in a task title — used
                      to push the row wider than the panel and put a horizontal
                      scrollbar across the whole board. */}
                    <span data-testid="task-board-task-text" className="min-w-0 break-words">
                      {status === 'in_progress' && task.activeForm ? task.activeForm : task.content}
                    </span>
                  </li>
                )),
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
