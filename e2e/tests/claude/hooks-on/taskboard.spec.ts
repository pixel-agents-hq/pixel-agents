import { expect, test } from '../../../fixtures/pixel-agents';
import {
  preToolUseBash,
  preToolUseTodoWrite,
  sessionEndClear,
  sessionStartClear,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  mockClaudeInitRecord,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import {
  expectNoTaskBoard,
  expectOverlayCount,
  expectOverlayVisible,
  expectSingleAgentOverlay,
  expectTaskBoardProgress,
  expectTaskBoardRows,
  getTaskBoardCards,
} from '../../../helpers/office';
import {
  clickTasksToggle,
  getPixelAgentsFrame,
  getTasksToggle,
  openPixelAgentsPanel,
} from '../../../helpers/webview';

const SPEC_TASK = 'Write the task board spec';
const PANEL_TASK = 'Add the task board panel';
const PANEL_TASK_ACTIVE = 'Adding the task board panel'; // activeForm of PANEL_TASK
const SHIP_TASK = 'Ship it';
const INVENTORY_TASK = 'Regenerate the inventory';

test.describe('Hooks ON / task board', () => {
  test('publishes a task board from TodoWrite, replaces it wholesale, and retracts it on an empty list @area:tasks', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging three timed TodoWrite calls: first list, wholesale replacement, empty list',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board publish, replace, retract')
        .at(8_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: PANEL_TASK, status: 'in_progress', activeForm: PANEL_TASK_ACTIVE },
            { content: SPEC_TASK, status: 'pending' },
            { content: SHIP_TASK, status: 'pending' },
          ]) as Record<string, unknown>,
        )
        .at(16_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: PANEL_TASK, status: 'completed', activeForm: PANEL_TASK_ACTIVE },
            { content: SPEC_TASK, status: 'in_progress' },
            { content: INVENTORY_TASK, status: 'pending' },
          ]) as Record<string, unknown>,
        )
        .at(24_000)
        .emitHook(preToolUseTodoWrite('{{sessionId}}', []) as Record<string, unknown>)
        .holdOpenFor(30_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    narrator.step('checking there is no board and no Tasks button before any TodoWrite');
    await expectNoTaskBoard(panelFrame);
    await expect(getTasksToggle(panelFrame)).toHaveCount(0);
    narrator.check('no board and no Tasks button before any TodoWrite');

    narrator.step('waiting for the t+8s TodoWrite to publish the first task list');
    await expectTaskBoardRows(panelFrame, agentId, [
      { status: 'in_progress', text: PANEL_TASK_ACTIVE },
      { status: 'pending', text: SPEC_TASK },
      { status: 'pending', text: SHIP_TASK },
    ]);
    await expectTaskBoardProgress(panelFrame, agentId, '0/3');
    await expect(getTaskBoardCards(panelFrame)).toHaveCount(1);
    await expect(getTasksToggle(panelFrame)).toBeVisible();
    narrator.check(
      'board shows in_progress -> pending -> pending, using activeForm for the running row',
    );

    narrator.step('waiting for the t+16s TodoWrite to replace the list wholesale');
    await expectTaskBoardRows(panelFrame, agentId, [
      { status: 'in_progress', text: SPEC_TASK },
      { status: 'pending', text: INVENTORY_TASK },
      { status: 'completed', text: PANEL_TASK },
    ]);
    await expectTaskBoardProgress(panelFrame, agentId, '1/3');
    narrator.check(
      'list replaced wholesale — SHIP_TASK dropped, completed row reads content not activeForm',
    );

    narrator.step('waiting for the t+24s empty TodoWrite to retract the board');
    await expectNoTaskBoard(panelFrame, 15_000);
    await expect(getTasksToggle(panelFrame)).toHaveCount(0, { timeout: 15_000 });
    await expectOverlayCount(panelFrame, 1);
    narrator.check('board and Tasks button gone; the character survives');
  });

  test('the Tasks toggle hides and reshows the board @area:tasks', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('arranging a single TodoWrite call at t+6s');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('task board toggle hide and reshow')
        .at(6_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: PANEL_TASK, status: 'in_progress', activeForm: PANEL_TASK_ACTIVE },
            { content: SPEC_TASK, status: 'pending' },
          ]) as Record<string, unknown>,
        )
        .holdOpenFor(20_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    narrator.step('waiting for the board to appear');
    await expect(getTaskBoardCards(panelFrame)).toHaveCount(1, { timeout: 20_000 });
    narrator.check('board is up');

    narrator.step('clicking the Tasks toggle to hide the board');
    await clickTasksToggle(panelFrame);
    await expectNoTaskBoard(panelFrame, 5_000);
    await expect(getTasksToggle(panelFrame)).toBeVisible();
    narrator.check('board hidden; Tasks button remains (gated on hasTasks, not isTaskBoardOpen)');

    narrator.step('clicking the Tasks toggle again to reshow the board');
    await clickTasksToggle(panelFrame);
    await expect(getTaskBoardCards(panelFrame)).toHaveCount(1, { timeout: 5_000 });
    await expectTaskBoardRows(panelFrame, agentId, [
      { status: 'in_progress', text: PANEL_TASK_ACTIVE },
      { status: 'pending', text: SPEC_TASK },
    ]);
    narrator.check('board reappears with the same list — React state, not remounted content');
  });

  test('/clear empties the board while the character is reassigned @area:tasks', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging a TodoWrite followed by a /clear — old session ends, a new one runs "npm test"',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear empties the task board')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(4_000)
        .emitHook(
          preToolUseTodoWrite('{{sessionId}}', [
            { content: PANEL_TASK, status: 'in_progress', activeForm: PANEL_TASK_ACTIVE },
            { content: SPEC_TASK, status: 'pending' },
          ]) as Record<string, unknown>,
        )
        .at(9_000)
        .emitHook(sessionEndClear('{{sessionId}}') as Record<string, unknown>)
        .at(9_100)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-ready'), {
          session: 'replacement',
        })
        .at(9_300)
        .emitHook(
          sessionStartClear(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(9_800)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm test') as Record<
            string,
            unknown
          >,
        )
        .holdOpenFor(16_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    narrator.step('waiting for the t+4s TodoWrite to publish the board');
    await expectTaskBoardRows(panelFrame, agentId, [
      { status: 'in_progress', text: PANEL_TASK_ACTIVE },
      { status: 'pending', text: SPEC_TASK },
    ]);
    narrator.check('board is up for the pre-clear session');

    narrator.step('waiting for the reassigned character to run the new session');
    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    narrator.check('same character shows "Running: npm test" — reassigned to the new session');

    narrator.step(
      'checking the empty-array agentTasks broadcast from clearTasks retracted the board',
    );
    await expectNoTaskBoard(panelFrame, 10_000);
    await expect(getTasksToggle(panelFrame)).toHaveCount(0);
    narrator.check('the board belonged to the cleared session - it is gone, the character is not');
  });
});
