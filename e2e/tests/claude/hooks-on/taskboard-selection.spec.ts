import { expect, test } from '../../../fixtures/pixel-agents';
import { preToolUseBash, preToolUseTodoWrite } from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import {
  expectAgentSelected,
  expectNoTaskBoard,
  expectOverlayCount,
  expectSingleAgentOverlay,
  expectTaskBoardErrand,
  expectTaskBoardRows,
  getActiveTaskBoardTabId,
  getTaskBoardCards,
  getTaskBoardForAgent,
  getTaskBoardTab,
  getTaskBoardTabs,
  readAgentOverlayIds,
  selectCharacter,
} from '../../../helpers/office';
import { getPixelAgentsFrame, openPixelAgentsPanel } from '../../../helpers/webview';

const PLAN_TASK = 'Plan the errand';
const PLAN_TASK_ACTIVE = 'Planning the errand';
const WALK_TASK = 'Walk to the board';
const WALK_TASK_ACTIVE = 'Walking to the board';
const REVIEW_TASK = 'Review the FSM';
const REVIEW_TASK_ACTIVE = 'Reviewing the FSM';
const SHIP_TASK = 'Ship it';

test.describe('Hooks ON / task board — office errand and selection', () => {
  test('an agent walks to the office task board when it revises its list, then returns @area:tasks', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('arranging one TodoWrite at t+6s — the revision that sends the agent walking');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board errand')
        .at(6_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: WALK_TASK, status: 'in_progress', activeForm: WALK_TASK_ACTIVE },
            { content: SHIP_TASK, status: 'pending' },
          ]) as Record<string, unknown>,
        )
        .holdOpenFor(30_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    narrator.step('checking the agent is not on a board errand before any TodoWrite');
    await expectTaskBoardErrand(panelFrame, agentId, null, 3_000);

    narrator.step('waiting for the t+6s revision to send the character to the whiteboard');
    // Goes straight to 'writing': the walk is only a few tiles, so polling can
    // miss the 'walking' phase entirely. Arrival is the outcome that matters.
    await expectTaskBoardErrand(panelFrame, agentId, 'writing', 20_000);
    narrator.check('character reached the board and is writing on it');

    narrator.step('waiting for the dwell to end and the errand to release the character');
    await expectTaskBoardErrand(panelFrame, agentId, null, 15_000);
    await expectOverlayCount(panelFrame, 1);
    narrator.check('errand over, character back under normal FSM control');
  });

  test('a revision inside the cooldown updates the board without a second walk @area:tasks', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('arranging two TodoWrite calls 10s apart — inside the 20s visit cooldown');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board visit cooldown')
        .at(6_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: WALK_TASK, status: 'in_progress', activeForm: WALK_TASK_ACTIVE },
            { content: SHIP_TASK, status: 'pending' },
          ]) as Record<string, unknown>,
        )
        .at(16_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: WALK_TASK, status: 'completed', activeForm: WALK_TASK_ACTIVE },
            { content: SHIP_TASK, status: 'in_progress' },
          ]) as Record<string, unknown>,
        )
        .holdOpenFor(40_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    narrator.step('waiting for the first revision to complete its board visit');
    await expectTaskBoardErrand(panelFrame, agentId, 'writing', 20_000);
    await expectTaskBoardErrand(panelFrame, agentId, null, 15_000);
    narrator.check('first visit done');

    narrator.step('waiting for the t+16s revision — the board must update');
    await expectTaskBoardRows(panelFrame, agentId, [
      { status: 'in_progress', text: SHIP_TASK },
      { status: 'completed', text: WALK_TASK },
    ]);
    narrator.check('board reflects the second revision');

    // Stability check (rule 3): the cooldown suppresses the WALK, not the
    // update. Agents revise their list far more often than they finish a task,
    // and without the cooldown an agent would spend the session in transit.
    narrator.step('checking the second revision did NOT start another walk');
    await panelFrame.waitForTimeout(2_000);
    await expectTaskBoardErrand(panelFrame, agentId, null, 2_000);
    narrator.check('board updated in place — no second errand inside the cooldown');
  });

  test('the tab strip switches boards and selects that agent in the office @area:tasks', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('arranging a TodoWrite for the FIRST agent');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board tabs — agent one')
        .at(4_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: PLAN_TASK, status: 'in_progress', activeForm: PLAN_TASK_ACTIVE },
          ]) as Record<string, unknown>,
        )
        .holdOpenFor(40_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    narrator.step('arranging a TodoWrite for the SECOND agent');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board tabs — agent two')
        .at(4_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: REVIEW_TASK, status: 'in_progress', activeForm: REVIEW_TASK_ACTIVE },
            { content: SHIP_TASK, status: 'pending' },
          ]) as Record<string, unknown>,
        )
        .holdOpenFor(40_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 2);
    const [first, second] = (await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b);

    narrator.step('waiting for both agents to publish, giving the strip two tabs');
    await expect(getTaskBoardTabs(panelFrame)).toHaveCount(2, { timeout: 25_000 });
    // Exactly one board is on screen, never one card per agent — the strip
    // replaced the stacked layout precisely because stacking ran off-screen.
    await expect(getTaskBoardCards(panelFrame)).toHaveCount(1);
    narrator.check('two tabs, one visible board');

    narrator.step(`clicking the tab for agent ${second}`);
    await getTaskBoardTab(panelFrame, second!).click();

    await expect(getTaskBoardForAgent(panelFrame, second!)).toBeVisible({ timeout: 10_000 });
    await expect(getTaskBoardCards(panelFrame)).toHaveCount(1);
    expect(await getActiveTaskBoardTabId(panelFrame)).toBe(second);
    await expectTaskBoardRows(panelFrame, second!, [
      { status: 'in_progress', text: REVIEW_TASK_ACTIVE },
      { status: 'pending', text: SHIP_TASK },
    ]);
    narrator.check('board switched to the clicked agent');

    // The half that was broken before: the tab click has to reach the canvas
    // too, or the office keeps highlighting whoever it had.
    narrator.step('checking the tab click also SELECTED that agent in the office');
    await expectAgentSelected(panelFrame, second!, true);
    await expectAgentSelected(panelFrame, first!, false);
    narrator.check('selecting a board selects its agent');
  });

  test('selecting an agent switches the board; one with no list hides it but keeps the tabs @area:tasks', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('arranging a TodoWrite for the FIRST agent — it gets a board');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board selection — publisher')
        .at(4_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: PLAN_TASK, status: 'in_progress', activeForm: PLAN_TASK_ACTIVE },
          ]) as Record<string, unknown>,
        )
        .holdOpenFor(40_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    narrator.step('arranging a SECOND agent that only runs a command — it never gets a board');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board selection — no board')
        .at(4_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(40_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 2);
    const ids = (await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b);
    const publisher = ids[0]!;
    const boardless = ids[1]!;

    narrator.step('waiting for the publisher to put its board up');
    await expectTaskBoardRows(panelFrame, publisher, [
      { status: 'in_progress', text: PLAN_TASK_ACTIVE },
    ]);
    // One board and it belongs to the selected agent, so the strip is redundant.
    await expect(getTaskBoardTabs(panelFrame)).toHaveCount(0);
    narrator.check('single board, no strip needed');

    narrator.step(`selecting agent ${boardless}, which never published a list`);
    await selectCharacter(panelFrame, boardless);

    await expectNoTaskBoard(panelFrame, 5_000);
    narrator.check('board hidden — it belonged to a different agent');

    // The strip must survive: it is the only control that can bring a board
    // back from here. Hiding it too would strand the user with an empty panel.
    narrator.step('checking the tab strip is still there to switch back with');
    await expect(getTaskBoardTabs(panelFrame)).toHaveCount(1);
    expect(await getActiveTaskBoardTabId(panelFrame)).toBeNull();
    narrator.check('tab still offered, and no tab claims to be active');

    narrator.step('clicking that tab to bring the board back');
    await getTaskBoardTab(panelFrame, publisher).click();
    await expectTaskBoardRows(panelFrame, publisher, [
      { status: 'in_progress', text: PLAN_TASK_ACTIVE },
    ]);
    await expectAgentSelected(panelFrame, publisher, true);
    narrator.check('board restored and its agent selected');
  });
});
