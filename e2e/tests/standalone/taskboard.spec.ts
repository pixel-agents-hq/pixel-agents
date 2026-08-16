import { test } from '../../fixtures/standalone';
import {
  preToolUseBash,
  preToolUseTodoWrite,
  sendHookEvent,
  sessionStartStartup,
} from '../../helpers/hooks';
import {
  expectNoTaskBoard,
  expectOverlayCount,
  expectSingleAgentOverlay,
  expectTaskBoardErrand,
  expectTaskBoardRows,
} from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

const RESEND_TASK = 'Survive a panel reload';
const RESEND_TASK_ACTIVE = 'Surviving a panel reload';
const REPLAY_TASK = 'Replay without walking';

test.describe('Standalone / task board', () => {
  test('the board survives a page reload and the replay does not send the agent walking @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    await standalone.drainMessages();

    const sessionId = 'standalone-taskboard-resend';

    // Standalone is the documented exception to the scenario-builder rule:
    // there is no VS Code terminal to host a mocked `claude`, so hook events go
    // straight to the server's endpoint (e2e/README.md → Mocking model & rules).
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    const agentId = await expectSingleAgentOverlay(page);

    await expectNoTaskBoard(page);

    await sendHookEvent(
      standalone.hookServerConfig,
      preToolUseTodoWrite(sessionId, [
        { content: RESEND_TASK, status: 'in_progress', activeForm: RESEND_TASK_ACTIVE },
        { content: REPLAY_TASK, status: 'pending' },
      ]),
    );
    await expectTaskBoardRows(page, agentId, [
      { status: 'in_progress', text: RESEND_TASK_ACTIVE },
      { status: 'pending', text: REPLAY_TASK },
    ]);

    // Let the revision's board visit finish, so a walk observed after the
    // reload can only have been caused by the reload itself.
    await expectTaskBoardErrand(page, agentId, null, 20_000);

    // Reload. The list is never written to disk — a board restored from a
    // previous RUN would describe a turn that already ended — but the running
    // server still holds it, and the client that just dropped is the only thing
    // that forgot. Without the resend the board stays blank until the agent's
    // next revision.
    await page.goto(standalone.hostUrl);
    await expectOverlayCount(page, 1);

    await expectTaskBoardRows(page, agentId, [
      { status: 'in_progress', text: RESEND_TASK_ACTIVE },
      { status: 'pending', text: REPLAY_TASK },
    ]);

    // The replay carries the same list as a revision but is not one. Without
    // the `replay` flag on the message, every agent holding a board would march
    // to the office whiteboard on every reload. Stability check (rule 3): the
    // walk would start a beat after the handshake, not instantly.
    await page.waitForTimeout(3_000);
    await expectTaskBoardErrand(page, agentId, null, 2_000);
    await expectTaskBoardRows(page, agentId, [
      { status: 'in_progress', text: RESEND_TASK_ACTIVE },
      { status: 'pending', text: REPLAY_TASK },
    ]);
  });

  test('an empty list is not replayed, so a retracted board stays retracted @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    await standalone.drainMessages();

    const sessionId = 'standalone-taskboard-retracted';

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    const agentId = await expectSingleAgentOverlay(page);

    await sendHookEvent(
      standalone.hookServerConfig,
      preToolUseTodoWrite(sessionId, [
        { content: RESEND_TASK, status: 'in_progress', activeForm: RESEND_TASK_ACTIVE },
      ]),
    );
    await expectTaskBoardRows(page, agentId, [{ status: 'in_progress', text: RESEND_TASK_ACTIVE }]);

    // The agent clears its list: `agentTasks: []` is the RETRACTION message.
    await sendHookEvent(standalone.hookServerConfig, preToolUseTodoWrite(sessionId, []));
    await expectNoTaskBoard(page, 10_000);

    await page.goto(standalone.hostUrl);
    await expectOverlayCount(page, 1);

    // A reconnecting client has no board to retract, so replaying an empty list
    // would be a statement about something that never existed. Settle wait
    // before the negative assertion (rule 2).
    await page.waitForTimeout(1_500);
    await expectNoTaskBoard(page, 2_000);
  });
});
