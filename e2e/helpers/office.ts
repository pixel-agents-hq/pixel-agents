import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { narrate } from './test-narration';

/**
 * Overlay helpers work the same against a VS Code webview iframe (Frame) and
 * a standalone browser page (Page). Both Playwright surfaces expose `locator`
 * with identical semantics for the queries used here.
 */
type OverlaySurface = Frame | Page;

const OVERLAY_TIMEOUT_MS = 15_000;

/**
 * Wait-strategy conventions for tests using this helper module:
 *
 * 1. **Positive assertion** ("X should appear"): use `expectOverlayVisible`,
 *    `expectOverlayCount(N>0)`, or `expectOverlayVisibleWithTexts`. These poll
 *    until the assertion succeeds or the timeout expires — no explicit
 *    `waitForTimeout` is needed before them.
 *
 * 2. **Negative assertion** ("X should NOT appear"): use `expectNoOverlay` /
 *    `expectNoOverlayWithTexts` with the desired timeout. A brief
 *    `waitForTimeout` before is a settling wait (give the runtime a chance to
 *    do the wrong thing before checking absence). Keep these short (<1s).
 *
 * 3. **Stability check** ("state remains correct N seconds later"): use
 *    `waitForTimeout(N)` followed by a re-assertion. This pattern guards
 *    against bugs where a state transition is correct momentarily then
 *    regresses (e.g. cleanup race vs. zombie re-spawn). Polling cannot
 *    replace stability checks because `expect.poll` returns at the first
 *    match, not after the state holds for N seconds.
 */

export function getAgentOverlays(frame: OverlaySurface): Locator {
  return frame.locator('[data-testid="agent-overlay"]');
}

export function getOverlayByText(frame: OverlaySurface, text: string): Locator {
  return getAgentOverlays(frame).filter({ hasText: text });
}

export function getOverlayByTexts(frame: OverlaySurface, texts: string[]): Locator {
  return texts.reduce<Locator>(
    (locator, text) => locator.filter({ hasText: text }),
    getAgentOverlays(frame),
  );
}

export function getOverlayByAgentId(frame: OverlaySurface, agentId: number): Locator {
  return frame.locator(`[data-testid="agent-overlay"][data-agent-id="${agentId}"]`);
}

export async function expectOverlayCount(
  frame: OverlaySurface,
  count: number,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getAgentOverlays(frame)).toHaveCount(count, { timeout });
}

export async function expectOverlayVisible(
  frame: OverlaySurface,
  text: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByText(frame, text).first()).toBeVisible({ timeout });
}

export async function expectOverlayVisibleWithTexts(
  frame: OverlaySurface,
  texts: string[],
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts).first()).toBeVisible({ timeout });
}

export async function expectOverlayVisibleForAgent(
  frame: OverlaySurface,
  agentId: number,
  text: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByAgentId(frame, agentId).filter({ hasText: text })).toBeVisible({
    timeout,
  });
}

export async function expectNoOverlay(
  frame: OverlaySurface,
  text: string,
  timeout = 1_000,
): Promise<void> {
  await expect(getOverlayByText(frame, text)).toHaveCount(0, { timeout });
}

export async function expectNoOverlayWithTexts(
  frame: OverlaySurface,
  texts: string[],
  timeout = 1_000,
): Promise<void> {
  await expect(getOverlayByTexts(frame, texts)).toHaveCount(0, { timeout });
}

/**
 * Context gauges. Every agent that has taken a turn shows one; sub-agents
 * never do, so the count doubles as an assertion about who owns a session.
 */
export function getContextGauges(frame: OverlaySurface): Locator {
  return frame.locator('[data-testid="context-gauge"]');
}

export async function expectContextGauge(
  frame: OverlaySurface,
  percent: number,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getContextGauges(frame).first()).toHaveAttribute(
    'data-context-pct',
    String(percent),
    { timeout },
  );
}

export interface TaskBoardRow {
  status: 'in_progress' | 'pending' | 'completed';
  text: string;
}

/** All per-agent task-board cards currently rendered. Zero cards == no board:
 *  the panel renders null when no agent has published a list. */
export function getTaskBoardCards(frame: OverlaySurface): Locator {
  return frame.locator('[data-testid="task-board-agent"]');
}

export function getTaskBoardForAgent(frame: OverlaySurface, agentId: number): Locator {
  return frame.locator(`[data-testid="task-board-agent"][data-agent-id="${agentId}"]`);
}

/** Rows of one agent's card, in DOM order (the board's grouped order:
 *  in_progress -> pending -> completed). */
export function getTaskBoardRows(frame: OverlaySurface, agentId: number): Locator {
  return getTaskBoardForAgent(frame, agentId).locator('[data-testid="task-board-task"]');
}

/** Poll until the agent's card shows exactly `expected`, in order. */
export async function expectTaskBoardRows(
  frame: OverlaySurface,
  agentId: number,
  expected: TaskBoardRow[],
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(
      async () =>
        getTaskBoardRows(frame, agentId).evaluateAll((elements) =>
          elements.map((element) => ({
            status: element.getAttribute('data-status') ?? '',
            text:
              element.querySelector('[data-testid="task-board-task-text"]')?.textContent?.trim() ??
              '',
          })),
        ),
      {
        message: `Expected agent ${agentId}'s task board rows to equal ${JSON.stringify(expected)}`,
        timeout,
      },
    )
    .toEqual(expected);
}

/** Poll until the card header reads `${completed}/${total}`. */
export async function expectTaskBoardProgress(
  frame: OverlaySurface,
  agentId: number,
  progress: string,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(
    getTaskBoardForAgent(frame, agentId).locator('[data-testid="task-board-progress"]'),
  ).toHaveText(progress, { timeout });
}

/** Negative assertion: no task board card anywhere. Short default timeout, per the
 *  file's wait-strategy conventions (rule 2). */
export async function expectNoTaskBoard(frame: OverlaySurface, timeout = 1_000): Promise<void> {
  await expect(getTaskBoardCards(frame)).toHaveCount(0, { timeout });
}

/**
 * Assert which agent the office considers selected, via the one user-visible
 * consequence of selection: only the selected top-level agent's overlay shows
 * the "Close agent" (×) button (ToolOverlay gates it on `isSelected`).
 *
 * That makes it the right probe for "did the task board select this agent" —
 * it reads what the office actually renders rather than the flag behind it.
 */
export async function expectAgentSelected(
  frame: OverlaySurface,
  agentId: number,
  selected = true,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  const closeButton = getOverlayByAgentId(frame, agentId)
    .first()
    .locator('button[title="Close agent"]');
  if (selected) {
    await expect(closeButton).toBeVisible({ timeout });
  } else {
    await expect(closeButton).toHaveCount(0, { timeout });
  }
  narrate.check(`agent ${agentId} is ${selected ? 'selected' : 'not selected'}`);
}

/** Tabs of the task board strip — one per agent that has published a list. */
export function getTaskBoardTabs(frame: OverlaySurface): Locator {
  return frame.locator('[data-testid="task-board-tab"]');
}

export function getTaskBoardTab(frame: OverlaySurface, agentId: number): Locator {
  return frame.locator(`[data-testid="task-board-tab"][data-agent-id="${agentId}"]`);
}

/** The tab currently marked active, by agent id — null when none is (which is
 *  the state while a selected agent has no board of its own). */
export async function getActiveTaskBoardTabId(frame: OverlaySurface): Promise<number | null> {
  const active = frame.locator('[data-testid="task-board-tab"][data-active="true"]');
  if ((await active.count()) === 0) return null;
  const id = await active.first().getAttribute('data-agent-id');
  return id === null ? null : Number(id);
}

/**
 * Poll until a character reaches the given task-board errand phase.
 *
 * The walk to the office whiteboard is pure canvas motion — no DOM of its own —
 * so this reads the character's errand state through the test hooks, the same
 * rationale as getCharacters/getPets. 'writing' means it has arrived and is
 * standing at the board; 'walking' means it is still on the way.
 */
export async function expectTaskBoardErrand(
  frame: OverlaySurface,
  agentId: number,
  phase: 'walking' | 'writing' | null,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(
      async () =>
        await frame.evaluate((id) => {
          interface ErrandHooks {
            getCharacters?: () => Array<{
              id: number;
              taskBoardErrand: 'walking' | 'writing' | null;
            }>;
          }
          const hooks = (window as { __pixelAgentsTestHooks?: ErrandHooks }).__pixelAgentsTestHooks;
          const character = (hooks?.getCharacters?.() ?? []).find((c) => c.id === id);
          return character ? character.taskBoardErrand : 'no-such-character';
        }, agentId),
      {
        message: `Expected agent ${agentId} task-board errand to be ${phase}`,
        timeout,
      },
    )
    .toBe(phase);
  narrate.check(
    phase === null
      ? `agent ${agentId} is not on a task-board errand`
      : `agent ${agentId} is ${phase} at the task board`,
  );
}

export async function readAgentOverlayIds(frame: OverlaySurface): Promise<number[]> {
  const rawIds = await getAgentOverlays(frame).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-agent-id')),
  );

  return rawIds.flatMap((value) => {
    const id = Number(value);
    return Number.isFinite(id) ? [id] : [];
  });
}

export async function readAgentOverlayTexts(
  frame: OverlaySurface,
): Promise<Array<{ id: number; text: string }>> {
  return getAgentOverlays(frame).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rawId = element.getAttribute('data-agent-id');
      const id = Number(rawId);
      if (!Number.isFinite(id)) {
        return [];
      }
      return [
        {
          id,
          text: element.textContent ?? '',
        },
      ];
    }),
  );
}

/** Wait for a specific agent's overlay to disappear. Prefer this over a global
 *  count-0 assertion when a replacement character may render around the same
 *  time — the global 0-count window can be shorter than Playwright's poll
 *  interval on slow runners. */
export async function expectAgentOverlayGone(
  frame: OverlaySurface,
  agentId: number,
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  await expect(getOverlayByAgentId(frame, agentId)).toHaveCount(0, { timeout });
}

export async function expectSingleAgentOverlay(frame: OverlaySurface): Promise<number> {
  await expectOverlayCount(frame, 1);
  const ids = await readAgentOverlayIds(frame);
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one agent overlay id, got ${JSON.stringify(ids)}`);
  }
  return ids[0]!;
}

/**
 * Assert whether the office's single character is drawn as a ghost — the
 * translucent rendering a headless agent gets (adopted from outside, so there
 * is no terminal to focus) while "Display Headless as Ghosts" is on.
 *
 * Both inputs to that decision are canvas-only: the per-character flag and the
 * renderer's setting. So this reads them through the test hooks and combines
 * them the same way the renderer does — same rationale as getCharacters/getPets.
 */
export async function expectCharacterGhosted(
  frame: OverlaySurface,
  ghosted: boolean,
): Promise<void> {
  await expect
    .poll(
      async () =>
        await frame.evaluate(() => {
          interface GhostHooks {
            getCharacters?: () => Array<{ id: number; isHeadless?: boolean }>;
            getGhostHeadlessAgents?: () => boolean;
          }
          const hooks = (window as { __pixelAgentsTestHooks?: GhostHooks }).__pixelAgentsTestHooks;
          const characters = hooks?.getCharacters?.() ?? [];
          if (characters.length !== 1) return `expected 1 character, got ${characters.length}`;
          const setting = hooks?.getGhostHeadlessAgents?.() ?? false;
          return characters[0]!.isHeadless === true && setting;
        }),
      { timeout: OVERLAY_TIMEOUT_MS },
    )
    .toBe(ghosted);
  narrate.check(`character is drawn ${ghosted ? 'as a ghost (translucent)' : 'fully opaque'}`);
}

/**
 * Assert the named teammate character occupies the free seat closest to its
 * lead. Seats and characters render only on the canvas (no DOM), so this reads
 * through the test hooks — the same rationale as getCharacters/getPets.
 *
 * Invariant checked: the teammate took the closest free seat at spawn time, so
 * afterwards no still-free seat may be strictly closer to the lead than the
 * teammate's own seat. Assumes the lead is the only other seated agent (true
 * for the lead+teammate scenarios that call this).
 */
export async function expectTeammateSeatedNextToLead(
  frame: OverlaySurface,
  teammateName: string,
): Promise<void> {
  const report = await frame.evaluate((name) => {
    interface SeatHooks {
      getCharacters?: () => Array<{ id: number; agentName?: string }>;
      getAgentSeats?: () => Array<{ id: number; seatId: string | null }>;
      getSeats?: () => Array<{ uid: string; col: number; row: number; assigned: boolean }>;
    }
    const hooks = (window as { __pixelAgentsTestHooks?: SeatHooks }).__pixelAgentsTestHooks;
    const characters = hooks?.getCharacters?.() ?? [];
    const agentSeats = hooks?.getAgentSeats?.() ?? [];
    const seats = hooks?.getSeats?.() ?? [];
    const teammate = characters.find((ch) => ch.agentName === name);
    if (!teammate) return { error: `no character named "${name}"` };
    const teammateSeatId = agentSeats.find((a) => a.id === teammate.id)?.seatId;
    const leadSeatId = agentSeats.find((a) => a.id !== teammate.id)?.seatId;
    const seatByUid = new Map(seats.map((s) => [s.uid, s]));
    const teammateSeat = teammateSeatId ? seatByUid.get(teammateSeatId) : undefined;
    const leadSeat = leadSeatId ? seatByUid.get(leadSeatId) : undefined;
    if (!teammateSeat || !leadSeat) return { error: 'lead or teammate has no seat' };
    const dist = (s: { col: number; row: number }): number =>
      Math.abs(s.col - leadSeat.col) + Math.abs(s.row - leadSeat.row);
    const teammateDist = dist(teammateSeat);
    const closerFreeSeat = seats.find((s) => !s.assigned && dist(s) < teammateDist) ?? null;
    return { error: null, teammateDist, closerFreeSeat };
  }, teammateName);

  expect(report, 'teammate and lead must both be seated').toMatchObject({ error: null });
  expect(report, 'no free seat may be closer to the lead than the teammate seat').toMatchObject({
    closerFreeSeat: null,
  });
}

/** Select a character (agent or sub-agent) through the deterministic test hook
 *  — the same officeState.selectedAgentId a canvas click sets. Sub-agents use
 *  negative ids (first sub is -1). Selection is what reveals a sub-agent's
 *  live activity text in its overlay (hover shows only the subtask title). */
export async function selectCharacter(frame: OverlaySurface, agentId: number): Promise<void> {
  await frame.evaluate((id) => {
    window.__pixelAgentsTestHooks?.selectAgent?.(id);
  }, agentId);
}

export async function closeAgentFromOverlay(
  frame: OverlaySurface,
  options: { agentId?: number; text?: string },
  timeout = OVERLAY_TIMEOUT_MS,
): Promise<void> {
  const overlay =
    options.agentId !== undefined
      ? getOverlayByAgentId(frame, options.agentId).first()
      : getOverlayByText(frame, options.text ?? '').first();
  await expect(overlay).toBeVisible({ timeout });

  // Selecting an agent is what reveals its "Close agent" (×) button. The
  // production path selects via a canvas hit-test on the sprite; driving that
  // from a test means computing pixel offsets below the overlay, which is
  // geometry-brittle and previously caused retry-flakes (e.g. the "close via
  // X" lifecycle test). Instead, select deterministically through the test
  // hook: it sets officeState.selectedAgentId (the same state a click sets),
  // and ToolOverlay re-renders every rAF, so the × button surfaces and becomes
  // clickable on the next frame. The overlay carries its agent id as
  // data-agent-id, so the text-based lookup path resolves an id too.
  const agentId = options.agentId ?? Number(await overlay.getAttribute('data-agent-id'));
  await frame.evaluate((id) => {
    window.__pixelAgentsTestHooks?.selectAgent?.(id);
  }, agentId);

  const closeButton = overlay.locator('button[title="Close agent"]');
  await expect(closeButton).toBeVisible({ timeout });
  narrate.step('closing the agent via its "×" overlay button');
  await closeButton.click();
}
