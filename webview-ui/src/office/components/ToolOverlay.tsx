import type { ReactNode } from 'react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  CHARACTER_SITTING_OFFSET_PX,
  COMPACT_LABEL_FONT_PX,
  COMPACT_LABEL_LIFT_PX,
  COMPACT_LABEL_MAX_WIDTH_PX,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  LABEL_FOCUSED_MAX_WIDTH_PX,
  LABEL_MAX_SHIFT_PX,
  LABEL_ROW_BAND_PX,
  LABEL_STACK_GAP_PX,
  LABEL_TITLE_MAX_CHARS,
  LOOP_LABEL_TEXT,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  SMOKE_BREAK_TAG,
  STUCK_LABEL_TEXT,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
} from '../../constants.js';
import type {
  AgentProgressState,
  AgentSleepState,
  SubagentCharacter,
} from '../../hooks/useExtensionMessages.js';
import { AgentLinkAction } from '../../inbox/AgentLinkAction.js';
import { pausedTag } from '../../inbox/inboxModel.js';
import { useInboxState } from '../../inbox/inboxStore.js';
import { APPROVAL_LABEL_TEXT } from '../../permissions/approvalState.js';
import type { PipState, WaitLevel } from '../../progress/progressFormat.js';
import {
  countLabel,
  formatWait,
  hasStageTrack,
  PHASE_LABELS,
  PHASES,
  pipState,
  sleepLabel,
  waitLevel,
} from '../../progress/progressFormat.js';
import { signalLabel } from '../../signals/signalFormat.js';
import { signalStore } from '../../signals/signalStore.js';
import { labelDensity, originLabel } from '../agentLabel.js';
import { metricsOf } from '../agentLook.js';
import type { OfficeState } from '../engine/officeState.js';
import type { LabelBox } from '../labelLayout.js';
import { resolveLabelOverlaps } from '../labelLayout.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

// Stage track + waiting badge rows: tiny, one line each, leading-none so a row
// is exactly its font size plus the gap above it. The panel lifts by that much
// so the extra rows grow it upward instead of over the character's head.
const STAGE_TRACK_FONT_PX = 12;
const WAIT_BADGE_FONT_PX = 14;
const PROGRESS_ROW_GAP_PX = 2;
// The parent's "👥 2 helpers" row (text-2xs, leading-none), lifted the same way.
const HELPERS_LINE_FONT_PX = 16;
// The signals row ("🌀 going in circles?", "🚨 stuck?"), lifted the same way.
const SIGNAL_LINE_FONT_PX = 14;

const PIP_COLORS: Record<PipState, string> = {
  done: 'var(--color-status-success)',
  current: 'var(--color-status-permission)',
  off: 'var(--color-text-muted)',
};

const WAIT_COLORS: Record<WaitLevel, string> = {
  none: 'var(--color-text-muted)',
  yellow: 'var(--color-status-permission)',
  red: 'var(--color-status-error)',
};

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  /** Stage track + waiting clock per top-level agent (agentProgress). */
  agentProgress: Record<number, AgentProgressState>;
  /** Sleeping agents (agentSleep): "💤 idle 3h" replaces their activity. */
  agentSleep: Record<number, AgentSleepState>;
  /** Task titles: the origin line reads `<title> · <repo>`. */
  agentTitles: Record<number, string>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
  /** Phone layout: with always-show on, unfocused labels shrink to their
   *  activity line (agentLabel.ts labelDensity). */
  compactLabels: boolean;
  /** Agents with a permission request (or question) waiting on the board,
   *  each with the text its label reads instead of its activity
   *  (agentsWithPending). The label always shows and opens the card on click. */
  approvalAgentIds?: ReadonlyMap<number, string>;
  onApprovalClick?: (id: number) => void;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

/** EXPLORE · BUILD · TEST · SHIP: reached green, current yellow, the rest dim. */
function StageTrack({ progress }: { progress: AgentProgressState }) {
  return (
    <span
      className="flex items-center gap-3 leading-none"
      style={{ fontSize: STAGE_TRACK_FONT_PX, marginTop: PROGRESS_ROW_GAP_PX }}
      data-testid="stage-track"
    >
      {PHASES.map((phase, i) => {
        const state = pipState(phase, progress.reached, progress.phase);
        return (
          <Fragment key={phase}>
            {i > 0 && <span className="text-text-muted opacity-60">·</span>}
            <span
              style={{ color: PIP_COLORS[state], opacity: state === 'off' ? 0.6 : 1 }}
              data-pip={phase}
              data-pip-state={state}
            >
              {PHASE_LABELS[phase]}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

/** One character's overlay for this frame. The label (if any) is built after
 *  the de-overlap pass, which needs every label's anchor first. */
interface OverlayEntry {
  id: number;
  bubble: ReactNode;
  /** Zero-size placeholder for a label that isn't drawn (see below). */
  marker: ReactNode;
  label: { left: number; top: number; render: (top: number) => ReactNode } | null;
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  agentProgress,
  agentSleep,
  agentTitles,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
  compactLabels,
  approvalAgentIds,
  onApprovalClick,
}: ToolOverlayProps) {
  // Needs-you inbox: usage-limit pauses and the Open-in-Claude / resume links.
  const inbox = useInboxState();
  const [, setTick] = useState(0);
  // Wall clock of the latest frame. This loop already re-renders the overlay
  // every frame (positions follow the characters), so the waiting badge counts
  // up from it with no timer of its own.
  const nowRef = useRef(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      nowRef.current = Date.now();
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Each drawn label's size (CSS px), measured after every render and used by
  // the next frame's de-overlap — a frame behind, which at 60 fps is never
  // seen, and keeps layout out of the render. Only labels drawn last frame.
  const labelSizesRef = useRef(new Map<number, { width: number; height: number }>());
  useLayoutEffect(() => {
    const sizes = new Map<number, { width: number; height: number }>();
    containerRef.current?.querySelectorAll<HTMLElement>('[data-label-box]').forEach((box) => {
      sizes.set(Number(box.dataset.agentId), { width: box.offsetWidth, height: box.offsetHeight });
    });
    labelSizesRef.current = sizes;
  });

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  const now = nowRef.current;
  const signals = signalStore.getSnapshot();

  // Live helpers per parent, for the parent's "👥 2 helpers" row. One leaving
  // (despawn effect playing) no longer counts.
  const helperCounts = new Map<number, number>();
  for (const sub of subagentCharacters) {
    const subCh = officeState.characters.get(sub.id);
    if (!subCh || subCh.matrixEffect === 'despawn') continue;
    helperCounts.set(sub.parentAgentId, (helperCounts.get(sub.parentAgentId) ?? 0) + 1);
  }

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  const entries: OverlayEntry[] = [];
  for (const id of allIds) {
    const ch = officeState.characters.get(id);
    if (!ch) continue;

    const isSelected = selectedId === id;
    const isHovered = hoveredId === id;
    const isSub = ch.isSubagent;
    const needsApproval = !isSub && approvalAgentIds?.has(id) === true;
    // Where the label and bubble hang above this character: lower over a
    // Clawd (half a chibi tall) than over a chibi, a crown higher over a lead
    // Clawd (agentLook.ts).
    const look = metricsOf(ch);
    const lift = ch.isTeamLead ? look.leadLift : 0;

    // Speech bubble (permission dots / done checkmark) — rendered here in
    // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
    // character regardless of label visibility. Mirrors the geometry the
    // canvas renderer used. The idle "Waiting for input" state speaks
    // through its label, not a bubble.
    let bubbleNode = null;
    if (ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) {
      const cachedBubble = getCachedSprite(
        ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
        zoom,
      );
      const bubbleSittingOff = ch.state === CharacterState.TYPE ? look.bubbleSitDrop : 0;
      const alpha =
        ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
          ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
          : 1;
      bubbleNode = (
        <div
          className="absolute -translate-x-1/2 pointer-events-none"
          style={{
            left: project.toScreenX(ch.x),
            // Bubble bottom sits one sprite pixel above the character's
            // anchor: project the anchor, then lift by the bubble's own
            // device-pixel height plus one zoomed pixel, in CSS px.
            top:
              project.toScreenY(ch.y + bubbleSittingOff - look.bubbleRise - lift) -
              (cachedBubble.height + zoom) / dpr,
            opacity: alpha,
            zIndex: OVERLAY_BUBBLE_Z_INDEX,
          }}
        >
          <OverlayBubble cached={cachedBubble} dpr={dpr} />
        </div>
      );
    }

    // Position above character
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    const screenX = project.toScreenX(ch.x);
    const screenY = project.toScreenY(ch.y + sittingOffset - look.labelRise - lift);
    // An empty positioned marker in place of a label panel, so overlay counts
    // stay stable and hover/select can still bring the panel back.
    const marker = (hidden?: string) => (
      <div
        className="absolute"
        style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
        data-testid="agent-overlay"
        data-agent-id={id}
        data-label-hidden={hidden}
      />
    );

    // Only show the label for hovered or selected agents (unless always-show
    // is on) — the bubble renders regardless. A helper's label shows only
    // while it or its parent is hovered or selected, even with always-show:
    // every helper labelled at once is what buried a busy board; the parent's
    // "👥 N helpers" row stands in for them.
    const parentFocused =
      isSub &&
      ch.parentAgentId !== null &&
      (selectedId === ch.parentAgentId || hoveredId === ch.parentAgentId);
    const showLabel = isSub
      ? isSelected || isHovered || parentFocused
      : alwaysShowOverlay || isSelected || isHovered || needsApproval;
    if (!showLabel) {
      // Under always-show this helper used to be labelled: keep its marker.
      const keep = isSub && alwaysShowOverlay;
      if (bubbleNode || keep) {
        entries.push({ id, bubble: bubbleNode, marker: keep && marker('helper'), label: null });
      }
      continue;
    }

    // A "Done" agent (finished turn: waiting bubble without awaitingInput)
    // shows ONLY its floating green checkmark bubble, never the label panel
    // (the panel would cover the bubble) — a marker holds its place. When
    // always-show is off, the visibility check above already keeps the panel
    // hidden for idle agents.
    // (A turn that stopped on a usage limit keeps its label: the ⏸️ tag says why.)
    const isDone =
      ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput && !(id > 0 && inbox.limits[id]);
    if (isDone && !isSelected && !isHovered && !needsApproval) {
      entries.push({ id, bubble: bubbleNode, marker: marker(), label: null });
      continue;
    }

    // Sleeping (open but idle session): "💤 idle 3h" instead of the activity,
    // no stage track, no waiting badge (the idle time says it). A pending
    // approval still reads as one.
    const sleep = isSub ? undefined : agentSleep[id];
    const asleep = sleep?.sleeping === true && ch.bubbleType !== 'permission' && !needsApproval;

    // Get activity text
    const hasWaitingBubble = ch.bubbleType === 'waiting';
    const subHasPermission = isSub && ch.bubbleType === 'permission';
    let activityText: string;
    if (needsApproval) {
      activityText = approvalAgentIds?.get(id) ?? APPROVAL_LABEL_TEXT;
    } else if (asleep) {
      activityText = sleepLabel(sleep.idleSince, now);
    } else if (hasWaitingBubble && ch.waitingAwaitingInput) {
      // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
      // shows only the checkmark and falls through to the normal idle text.
      activityText = WAITING_INPUT_ACTIVITY_TEXT;
    } else if (isSub) {
      if (subHasPermission) {
        activityText = 'Needs approval';
      } else {
        // Hover shows the subtask title; SELECTING the sub reveals its live
        // tool activity (watched sub-agents stream it via subagentToolStart).
        const sub = subagentCharacters.find((s) => s.id === id);
        const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
        const activeRow = isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
        activityText = activeRow?.status ?? (sub?.label || 'Subtask');
      }
    } else {
      activityText = getActivityText(
        id,
        agentTools,
        ch.isActive,
        ch.bubbleType,
        ch.waitingAwaitingInput ?? false,
      );
    }

    // Determine dot color
    const tools = agentTools[id];
    const hasPermission =
      needsApproval || subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
    const hasActiveTools = tools?.some((t) => !t.done);
    const isActive = ch.isActive;
    const hasWaiting = ch.bubbleType === 'waiting';

    let dotColor: string | null = null;
    if (asleep) {
      dotColor = null;
    } else if (hasPermission || hasWaiting) {
      dotColor = 'var(--color-status-permission)';
    } else if (isActive && hasActiveTools) {
      dotColor = 'var(--color-status-active)';
    }

    // Phone + always-show: a label nobody is looking at is its activity line
    // alone; the focused agent keeps every row.
    const focused = isSelected || isHovered;
    const compact =
      labelDensity({ compactLabels, alwaysShow: alwaysShowOverlay, focused }) === 'compact';

    // Team info
    const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;
    // Origin: `<title> · <repo>`, prefixed with where a relayed remote session
    // runs. The title is cut short unless this label is focused; the full line
    // is the row's tooltip either way.
    const source = isSub ? undefined : officeState.agentSources.get(id);
    const origin = {
      title: isSub ? undefined : agentTitles[id],
      directoryName: ch.directoryName,
      source,
    };
    const originText = originLabel(origin, focused ? Infinity : LABEL_TITLE_MAX_CHARS);
    const originFull = originLabel(origin);
    const hasExtraLines = !!(originText || teamRoleLabel);
    const helpers = isSub ? 0 : (helperCounts.get(id) ?? 0);
    const limit = isSub ? undefined : inbox.limits[id];

    // Context gauge. Every agent gets one — lead, teammate, adopted,
    // headless — as soon as it has taken a turn. Sub-agents never do: they
    // have no session of their own, so contextTokens stays 0.
    const contextRatio = ch.contextTokens / ch.maxContextTokens;
    const showContextGauge = !isSub && ch.contextTokens > 0;

    // Stage track and waiting badge: top-level agents only (a sub-agent has
    // no cycle of its own). The badge shows from the first moment of a wait;
    // its color steps up at 5 and 15 minutes.
    const progress = isSub || asleep ? undefined : agentProgress[id];
    const trackProgress = progress && hasStageTrack(progress) ? progress : null;
    // A usage-limit pause is not a wait on the user: no badge.
    const waitMs =
      progress?.waitingSince !== undefined && !limit
        ? Math.max(0, now - progress.waitingSince)
        : null;
    // Useful signals: the alarm's "stuck?" and the loop detector's line.
    const signalLine =
      isSub || asleep
        ? undefined
        : signalLabel(signals.trouble.get(id), signals.loops.has(id), {
            stuck: STUCK_LABEL_TEXT,
            loop: LOOP_LABEL_TEXT,
          });
    const extraRowsLiftPx =
      (signalLine ? SIGNAL_LINE_FONT_PX + PROGRESS_ROW_GAP_PX : 0) +
      (trackProgress ? STAGE_TRACK_FONT_PX + PROGRESS_ROW_GAP_PX : 0) +
      (waitMs !== null ? WAIT_BADGE_FONT_PX + PROGRESS_ROW_GAP_PX : 0) +
      (helpers > 0 ? HELPERS_LINE_FONT_PX : 0);

    const dimmed = alwaysShowOverlay && !isSelected && !isHovered && !needsApproval;
    // A focused label may grow wide enough for the whole title (never wider
    // than the screen, which a phone is narrower than).
    const panelMaxWidth = compact
      ? COMPACT_LABEL_MAX_WIDTH_PX
      : focused
        ? `min(${LABEL_FOCUSED_MAX_WIDTH_PX}px, calc(100vw - 16px))`
        : undefined;
    const renderLabel = (top: number) => (
      <div
        className="absolute flex flex-col items-center -translate-x-1/2"
        style={{
          left: screenX,
          top,
          pointerEvents: isSelected || needsApproval ? 'auto' : 'none',
          cursor: needsApproval ? 'pointer' : undefined,
          opacity: dimmed ? (isSub ? 0.5 : 0.75) : 1,
          zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
        }}
        data-testid="agent-overlay"
        data-agent-id={id}
        data-label-box=""
        data-label-density={compact ? 'compact' : 'full'}
        data-sleeping={asleep || undefined}
        data-needs-approval={needsApproval || undefined}
        onClick={
          needsApproval
            ? (e) => {
                e.stopPropagation();
                onApprovalClick?.(id);
              }
            : undefined
        }
      >
        <div
          className={`flex items-center border-border pixel-panel whitespace-nowrap ${compact ? 'px-4 pt-1 pb-2 gap-4' : 'px-8 pt-2 pb-4 gap-5'} ${panelMaxWidth === undefined ? 'max-w-2xs' : ''}`}
          style={{ maxWidth: panelMaxWidth }}
        >
          {dotColor && (
            <span
              className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
              style={{ background: dotColor }}
            />
          )}
          <div className="flex flex-col gap-0 overflow-hidden">
            {!compact && teamRoleLabel && (
              <span
                className="overflow-hidden text-ellipsis block leading-none"
                style={{
                  fontSize: '18px',
                  color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                  fontWeight: ch.isTeamLead ? 'bold' : undefined,
                }}
              >
                {teamRoleLabel}
              </span>
            )}
            <span
              className="overflow-hidden text-ellipsis block leading-none"
              style={{
                fontSize: compact ? COMPACT_LABEL_FONT_PX : isSub ? '20px' : '22px',
                fontStyle: isSub ? 'italic' : undefined,
                color: asleep ? 'var(--color-text-muted)' : undefined,
              }}
              data-testid={asleep ? 'sleep-label' : undefined}
            >
              {activityText}
              {/* A mid-work smoke (living office): the activity stays, tagged. */}
              {ch.smokeBreak && (
                <span className="text-2xs text-text-muted" data-testid="smoke-break-tag">
                  {' '}
                  {SMOKE_BREAK_TAG}
                </span>
              )}
              {/* Paused by a usage limit: not waiting on the user. */}
              {limit && (
                <span className="text-2xs text-text-muted" data-testid="paused-tag">
                  {' '}
                  {pausedTag(limit, now)}
                </span>
              )}
            </span>
            {!compact && originText && (
              <span
                className="text-2xs leading-none overflow-hidden text-ellipsis block"
                title={originFull}
                data-testid="origin-label"
              >
                {originText}
              </span>
            )}
            {!compact && helpers > 0 && (
              <span
                className="text-2xs leading-none overflow-hidden text-ellipsis block text-text-muted"
                data-testid="helpers-line"
              >
                👥 {countLabel(helpers, 'helper')}
              </span>
            )}
            {!compact && trackProgress && <StageTrack progress={trackProgress} />}
            {!compact && waitMs !== null && (
              <span
                className="block leading-none"
                style={{
                  fontSize: WAIT_BADGE_FONT_PX,
                  marginTop: PROGRESS_ROW_GAP_PX,
                  color: WAIT_COLORS[waitLevel(waitMs)],
                }}
                data-testid="waiting-badge"
                data-wait-level={waitLevel(waitMs)}
              >
                ⏳ waiting on you {formatWait(waitMs)}
              </span>
            )}
            {!compact && signalLine && (
              <span
                className="block leading-none"
                style={{
                  fontSize: SIGNAL_LINE_FONT_PX,
                  marginTop: PROGRESS_ROW_GAP_PX,
                  color: 'var(--color-status-permission)',
                }}
                data-testid="signal-line"
              >
                {signalLine}
              </span>
            )}
          </div>
          {isSelected && !isSub && <AgentLinkAction link={inbox.links[id]} variant="icon" />}
          {isSelected && !isSub && (
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onCloseAgent(id);
              }}
              title="Close agent"
              className="ml-2 shrink-0 leading-none"
            >
              ×
            </Button>
          )}
        </div>
        {!compact && showContextGauge && (
          <div
            style={{
              width: CONTEXT_GAUGE_WIDTH_PX,
              height: CONTEXT_GAUGE_HEIGHT_PX,
              background: CONTEXT_GAUGE_BG,
              marginTop: 2,
            }}
            title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
            data-testid="context-gauge"
            data-context-pct={Math.round(contextRatio * 100)}
          >
            <div
              style={{
                width: `${Math.min(contextRatio * 100, 100)}%`,
                height: '100%',
                background: getFuelColor(contextRatio),
              }}
            />
          </div>
        )}
      </div>
    );

    entries.push({
      id,
      bubble: bubbleNode,
      marker: null,
      label: {
        left: screenX,
        top: compact
          ? screenY - COMPACT_LABEL_LIFT_PX
          : screenY - (hasExtraLines ? 34 : 28) - extraRowsLiftPx,
        render: renderLabel,
      },
    });
  }

  // De-overlap: stack colliding labels upward (office/labelLayout.ts), from
  // the sizes measured after the last frame. A label new this frame has none
  // yet and joins next frame.
  const boxes: LabelBox[] = [];
  for (const { id, label } of entries) {
    const size = label && labelSizesRef.current.get(id);
    if (!label || !size) continue;
    boxes.push({ id, x: label.left - size.width / 2, y: label.top, ...size });
  }
  const shifts = resolveLabelOverlaps(boxes, {
    gap: LABEL_STACK_GAP_PX,
    maxShift: LABEL_MAX_SHIFT_PX,
    rowBand: LABEL_ROW_BAND_PX,
  });

  return (
    <>
      {entries.map(({ id, bubble, marker, label }) => (
        <Fragment key={id}>
          {bubble}
          {marker}
          {label?.render(label.top - (shifts.get(id) ?? 0))}
        </Fragment>
      ))}
    </>
  );
}
