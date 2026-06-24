import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  idlePrompt,
  permissionRequest,
  preToolUseBash,
  sendHookEvent,
  sessionEndExit,
  sessionStartStartup,
  stop,
  waitForHookServer,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisible } from '../../../helpers/office';
import {
  appendAssistantToolUse,
  appendJsonlRecord,
  buildUserToolResultRecord,
  getClaudeProjectDir,
} from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

test.describe('Hooks ON / spawn paths', () => {
  test('internal terminal spawns agent and Task subagent appears then despawns @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('internal terminal basic spawn').build(),
    );
    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    expect(spawned.invocationLog).toContain(`session-id=${spawned.sessionId}`);
    expect(path.basename(spawned.jsonlFile)).toBe(`${spawned.sessionId}.jsonl`);

    const terminalTab = window.getByText(/Claude Code #\d+/);
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 1);

    // Sub-character appears on Task tool_use and despawns on tool_result.
    // Task subagent lifecycle is JSONL-driven even in hooks-on mode
    // (transcriptParser routes Task/Agent tool events through JSONL
    // regardless of hookDelivered).
    const taskToolId = 'toolu-subagent-spawn';
    appendAssistantToolUse(spawned.jsonlFile, taskToolId, 'Task', {
      description: 'spawned subtask',
    });
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisible(panelFrame, 'Subtask: spawned subtask');

    appendJsonlRecord(spawned.jsonlFile, buildUserToolResultRecord(taskToolId));
    await expectOverlayCount(panelFrame, 1);
  });

  // External hook-driven session adoption.
  //
  // Driven directly from the test via sendHookEvent (not from mock-claude's
  // scheduler) for deterministic timing. The original timer-driven version
  // passed in isolation but flaked reliably under full-suite load: the
  // 200ms/2000ms/3200ms/4400ms/6000ms scheduled emissions slipped, and the
  // test raced to see all 5 effects within fixed wall-clock windows. The
  // teammate-routing tests use this same direct-emission pattern and don't
  // flake.
  test('external Claude session adopted via hook confirmation lifecycle @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    const serverConfig = await waitForHookServer(tmpHome);
    const sessionId = 'external-hook-session';

    // Spawn mock-claude with only autoInit; the test drives every hook below.
    // holdOpenFor(3_000) keeps the process alive briefly so the JSONL it created
    // stays attached during the assertions, then exits before fixture teardown
    // (the fixture's killTrackedExternalProcesses sweep is the fallback safety net).
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      scenario: claudeScenario('external hook-driven session adoption').holdOpenFor(3_000).build(),
      sessionId,
    });

    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    // 1. SessionStart fires. Session is pending (transient filter), no overlay yet.
    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));
    await frame.waitForTimeout(500); // give SessionStart time to land before asserting absence
    await expectOverlayCount(frame, 0);

    // 2. PreToolUseBash confirms the session; agent appears with bash status.
    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');

    // 3. PermissionRequest → "Needs approval"
    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectOverlayVisible(frame, 'Needs approval');

    // 4. Stop → finished turn shows ONLY the checkmark; the label falls back to
    //    idle (no dedicated text), distinct from idle_prompt's "Waiting for input".
    await sendHookEvent(serverConfig, stop(sessionId));
    await expectOverlayVisible(frame, 'Idle');

    // 5. Notification(idle_prompt) → "Waiting for input"
    await sendHookEvent(serverConfig, idlePrompt(sessionId));
    await expectOverlayVisible(frame, 'Waiting for input');

    // 6. SessionEnd(exit) → agent is removed.
    await sendHookEvent(serverConfig, sessionEndExit(sessionId));
    await expectOverlayCount(frame, 0);
  });
});
