import {
  ACTIVITY_CLOCK_WRAP_SEC,
  ACTIVITY_COMPLETION_DURATION_SEC,
  ACTIVITY_DELEGATION_TOOL_ALIASES,
  ACTIVITY_EXECUTION_TOOL_ALIASES,
  ACTIVITY_READING_TOOL_ALIASES,
  ACTIVITY_THINKING_TOOL_ALIASES,
  ACTIVITY_TYPING_TOOL_ALIASES,
  WAITING_BUBBLE_DURATION_SEC,
} from '../../constants.js';
import { isReadingToolName, isSubagentToolName } from '../toolUtils.js';
import type { Character } from '../types.js';
import { CharacterState } from '../types.js';

export type CharacterActivity =
  | 'typing'
  | 'reading'
  | 'executing'
  | 'delegating'
  | 'thinking'
  | 'walking'
  | 'idle'
  | 'permission'
  | 'waiting'
  | 'done';

const readingAliases = new Set<string>(ACTIVITY_READING_TOOL_ALIASES);
const thinkingAliases = new Set<string>(ACTIVITY_THINKING_TOOL_ALIASES);
const executionAliases = new Set<string>(ACTIVITY_EXECUTION_TOOL_ALIASES);
const typingAliases = new Set<string>(ACTIVITY_TYPING_TOOL_ALIASES);
const delegationAliases = new Set<string>(ACTIVITY_DELEGATION_TOOL_ALIASES);

/** Provider capabilities win; generic aliases also cover Kiro's native names.
 * Unknown tools are executing, never assumed to be a successful operation. */
export function classifyToolActivity(tool: string | null): CharacterActivity {
  if (!tool) return 'thinking';
  if (isReadingToolName(tool)) return 'reading';
  if (isSubagentToolName(tool)) return 'delegating';
  const name = tool
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_');
  if (thinkingAliases.has(name)) return 'thinking';
  if (readingAliases.has(name)) return 'reading';
  if (delegationAliases.has(name)) return 'delegating';
  if (typingAliases.has(name)) return 'typing';
  if (executionAliases.has(name)) return 'executing';
  return 'executing';
}

/** Visual status follows the existing agent lifecycle; effects cannot invent it. */
export function getCharacterActivity(ch: Character): CharacterActivity {
  if (ch.bubbleType === 'permission') return 'permission';
  if (!ch.isActive) {
    if (ch.waitingAwaitingInput) return 'waiting';
    if (ch.bubbleType === 'waiting') return 'done';
    return ch.state === CharacterState.WALK ? 'walking' : 'idle';
  }
  if (ch.state === CharacterState.WALK) return 'walking';
  if (ch.state === CharacterState.IDLE) return 'idle';
  return classifyToolActivity(ch.currentTool);
}

/** An ephemeral clock: independent of sprite-frame resets and never persisted. */
export function advanceActivityClock(ch: Character, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  ch.visualTime = ((ch.visualTime ?? 0) + dt) % ACTIVITY_CLOCK_WRAP_SEC;
}

/** Phase is stable per character, so a team doesn't all blink at the same time. */
export function activityPhase(ch: Character, duration: number): number {
  return (((ch.visualTime ?? 0) + Math.abs(ch.id) * 0.173) % duration) / duration;
}

/** Completion is the existing done speech bubble's first fraction of a second.
 * A question, a permission request, or an active agent never emits confetti. */
export function completionProgress(ch: Character): number | null {
  if (ch.isActive || ch.bubbleType !== 'waiting' || ch.waitingAwaitingInput || ch.bubbleTimer <= 0)
    return null;
  const elapsed = WAITING_BUBBLE_DURATION_SEC - ch.bubbleTimer;
  if (elapsed < 0 || elapsed >= ACTIVITY_COMPLETION_DURATION_SEC) return null;
  return elapsed / ACTIVITY_COMPLETION_DURATION_SEC;
}

/** One sprite pixel at most, with long rests between little reading nods. */
export function characterPoseOffset(ch: Character, animate: boolean): number {
  if (!animate || ch.matrixEffect || ch.isGreeter) return 0;
  const activity = getCharacterActivity(ch);
  if (activity === 'reading') {
    const phase = activityPhase(ch, 3.8);
    return phase > 0.63 && phase < 0.84 ? 1 : 0;
  }
  if (activity === 'typing') {
    const phase = activityPhase(ch, 4.6);
    return phase > 0.88 && phase < 0.95 ? 1 : 0;
  }
  if (activity === 'thinking' || activity === 'idle') {
    return activityPhase(ch, 5.4) > 0.87 ? 1 : 0;
  }
  return 0;
}
