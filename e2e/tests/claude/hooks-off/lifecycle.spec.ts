import { expect, test } from '../../../fixtures/pixel-agents';
import {
  spawnInternalAgentAndWait,
  spawnInternalAgentAndWaitForInvocation,
} from '../../../helpers/internal-agent';
import {
  INLINE_TEAMMATE_ALIAS,
  INLINE_TEAMMATE_ROLE,
  uniqueTeamName,
  withInlineTeammateSession,
} from '../../../helpers/lifecycle';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  mockClaudeInitRecord,
  spawnExternalClaudeScenario,
} from '../../../helpers/mock-claude';
import {
  closeAgentFromOverlay,
  expectNoOverlay,
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisible,
  expectOverlayVisibleForAgent,
  expectOverlayVisibleWithTexts,
  expectSingleAgentOverlay,
  readAgentOverlayIds,
  readAgentOverlayTexts,
} from '../../../helpers/office';
import {
  buildAssistantToolUseBatchRecord,
  buildAssistantToolUseRecord,
  buildClearCommandRecord,
  buildTeamConfig,
  buildTeamMetadataRecord,
  buildTurnDurationRecord,
  buildUserToolResultBatchRecord,
  buildUserToolResultRecord,
  seedTeamConfig,
} from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

const PARALLEL_PARENT_TOOL_ID = 'toolu-b5-parent';

function otherOverlayId(ids: number[], knownId: number): number {
  const otherId = ids.find((id) => id !== knownId);
  if (otherId === undefined) {
    throw new Error(`Expected an overlay id other than ${knownId}, got ${JSON.stringify(ids)}`);
  }
  return otherId;
}

test.describe('Hooks OFF / lifecycle', () => {
  test('/clear on internal agent reassigns the same character via JSONL polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear reassignment hooks off')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(3_500)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-ready'), {
          session: 'replacement',
        })
        .at(3_550)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b1-fresh', 'Bash', {
            command: 'npm test',
          }),
          { session: 'replacement' },
        )
        .at(5_100)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b1-stale', 'Bash', {
            command: 'npm run stale',
          }),
        )
        .holdOpenFor(8_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  // Heuristic --resume reassignment at agent startup.
  //
  // Scenario: user clicks + Agent → terminal runs `claude --session-id <UUID>`,
  // but the user actually types /resume (or claude --resume) so the session
  // generates a DIFFERENT id and writes to <other-id>.jsonl. The expected
  // <UUID>.jsonl never materializes. The heuristic in
  // adapters/vscode/agentManager.ts:177-211 polls for the expected file at 1Hz;
  // when pollCount > 10 and the expected file still doesn't exist, it scans
  // the project dir for any jsonl modified after agent creation and reassigns
  // the agent to the newest candidate.
  //
  // Coexists with the /clear content-disambiguation heuristic in
  // fileWatcher.ts:150-152 (which requires the literal "/clear</command-name>"
  // substring in the new JSONL to claim it as a /clear file); --resume traffic
  // doesn't carry that substring so the two heuristics route correctly.
  test('--resume reassigns the same agent within grace via JSONL polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('--resume reassignment hooks off')
        .withoutAutoInit()
        .defineSession('replacement', '{{sessionId}}-resume')
        .at(11_000)
        .appendJsonl(mockClaudeInitRecord('mock-claude-resume-ready'), {
          session: 'replacement',
        })
        .at(11_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b3-fresh', 'Bash', {
            command: 'npm test',
          }),
          { session: 'replacement' },
        )
        .holdOpenFor(16_000)
        .build(),
    );

    await spawnInternalAgentAndWaitForInvocation(frame, tmpHome, workspaceDir, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test', 16_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('/clear edge case with a sibling agent in the same projectDir via JSONL polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear edge sibling agent hooks off')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-sibling', 'Bash', {
            command: 'npm run sibling',
          }),
        )
        .holdOpenFor(12_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    let panelFrame = await getPixelAgentsFrame(window);
    const siblingAgentId = await expectSingleAgentOverlay(panelFrame);

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear reassign with sibling present hooks off')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(3_500)
        .appendJsonl(mockClaudeInitRecord('mock-claude-sibling-clear-ready'), {
          session: 'replacement',
        })
        .at(3_550)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-fresh', 'Bash', {
            command: 'npm run cleared',
          }),
          { session: 'replacement' },
        )
        .at(5_100)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-stale', 'Bash', {
            command: 'npm run stale',
          }),
        )
        .holdOpenFor(8_000)
        .build(),
    );

    await spawnInternalAgentAndWait(panelFrame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 2, 12_000);
    const clearingAgentId = otherOverlayId(await readAgentOverlayIds(panelFrame), siblingAgentId);

    await expectOverlayVisibleForAgent(panelFrame, clearingAgentId, 'Running: npm run cleared');
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    const overlayTexts = await readAgentOverlayTexts(panelFrame);
    const siblingOverlay = overlayTexts.find(({ id }) => id === siblingAgentId);
    expect(siblingOverlay).toBeDefined();
    expect(siblingOverlay?.text).not.toContain('npm run cleared');
    expect(siblingOverlay?.text).not.toContain('npm run stale');
    expect([...(await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b)]).toEqual([
      siblingAgentId,
      clearingAgentId,
    ]);
  });

  test('heuristic late --resume after stale cleanup prevents zombie agents @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'late-resume-old-session',
      scenario: claudeScenario('late resume after stale cleanup hooks off old')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b4-before', 'Bash', {
            command: 'npm run before-resume',
          }),
        )
        .at(6_500)
        .deletePath('{{transcriptPath}}')
        .holdOpenFor(10_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run before-resume');
    const oldAgentId = await expectSingleAgentOverlay(frame);

    await expectOverlayCount(frame, 0, 45_000);

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'late-resume-new-session',
      scenario: claudeScenario('late resume after stale cleanup hooks off new')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b4-late', 'Bash', {
            command: 'npm run late-resume',
          }),
        )
        .holdOpenFor(12_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run late-resume', 12_000);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);
  });

  test('three parallel Task subagents in one turn render distinct sub-characters via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('three parallel Task subagents in one turn hooks off')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseBatchRecord([
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-1`,
              toolName: 'Task',
              input: { description: 'Parallel task 1' },
            },
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-2`,
              toolName: 'Task',
              input: { description: 'Parallel task 2' },
            },
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-3`,
              toolName: 'Task',
              input: { description: 'Parallel task 3' },
            },
          ]),
        )
        .at(9_000)
        .appendJsonl(
          buildUserToolResultBatchRecord([
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-1` },
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-2` },
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-3` },
          ]),
        )
        .at(10_200)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(13_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisible(panelFrame, 'Subtask: Parallel task 3');
    await expectOverlayVisible(panelFrame, 'Parallel task 1');
    await expectOverlayVisible(panelFrame, 'Parallel task 2');
    await expectOverlayVisible(panelFrame, 'Parallel task 3');
    await expectOverlayCount(panelFrame, 4, 10_000);
    expect(await readAgentOverlayIds(panelFrame)).toHaveLength(4);

    await expectOverlayCount(panelFrame, 1, 16_000);
  });

  test('inline teammate removed from team config disappears within one second via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('teammate-removal-hooks-off');
    const configPath = seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      withInlineTeammateSession(claudeScenario('inline teammate removed from config hooks off'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(1_500)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b6-teammate-search', 'WebSearch', {
            query: 'pixel agents lifecycle regressions',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .at(8_000)
        .writeJson(configPath, buildTeamConfig(['lead']))
        .holdOpenFor(14_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 10_000);
    await expectOverlayVisible(panelFrame, 'Searching the web');
    await expectOverlayCount(panelFrame, 2, 10_000);

    await expectOverlayCount(panelFrame, 1, 12_000);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);

    // Stability check (heuristic mode): after the 1s team-config polling
    // removes the teammate, ensure it stays removed under continued polling.
    await panelFrame.waitForTimeout(8_000);
    await expectOverlayCount(panelFrame, 1);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
  });

  test('rapid /clear then new tool within 500ms lands on the reassigned agent via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('rapid clear then new tool under 500ms hooks off')
        .defineSession('replacement', '{{sessionId}}-clear-fast')
        .at(3_000)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-fast-ready'), {
          session: 'replacement',
        })
        .at(3_050)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(3_200)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b11-fresh', 'Bash', {
            command: 'npm run fresh',
          }),
          { session: 'replacement' },
        )
        .at(3_350)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b11-ghost', 'Bash', {
            command: 'npm run ghost',
          }),
        )
        .holdOpenFor(7_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm run fresh', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('close via X prevents re-adoption of old JSONL during dismissal cooldown via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'dismissal-cooldown-old-session',
      scenario: claudeScenario('dismissal cooldown hooks off old session')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b12-old-live', 'Bash', {
            command: 'npm run old-live',
          }),
        )
        .at(12_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b12-old-stale', 'Bash', {
            command: 'npm run old-stale',
          }),
        )
        .holdOpenFor(16_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run old-live');
    const oldAgentId = await expectSingleAgentOverlay(frame);
    await closeAgentFromOverlay(frame, { agentId: oldAgentId });
    await expectOverlayCount(frame, 0, 8_000);

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'dismissal-cooldown-new-session',
      scenario: claudeScenario('dismissal cooldown hooks off new session')
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b12-new-live', 'Bash', {
            command: 'npm run reopened',
          }),
        )
        .holdOpenFor(12_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run reopened', 12_000);
    await expectOverlayCount(frame, 1);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);

    // Stability check (heuristic mode): cover several external scanner ticks
    // (3s interval) to ensure the dismissed JSONL is not re-adopted.
    await frame.waitForTimeout(8_000);
    await expectNoOverlay(frame, 'Running: npm run old-stale', 2_000);
    await expectOverlayCount(frame, 1);
  });

  test('external basic subagent with run_in_background but no teamName routes to basic path @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    // Heuristic-mode mirror of the hooks-on external-background-subagent
    // case: external session with an Agent tool_use that carries
    // run_in_background=true but the lead has NO teamName. The regression
    // case is misrouting this to the teammate path, which would produce an
    // extra "general-purpose" teammate overlay alongside the basic Subtask
    // sub-character.
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'external-basic-background-subagent',
      scenario: claudeScenario('external basic subagent no teamName hooks off')
        .at(1_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b8-off-agent', 'Agent', {
            description: 'Background basic subtask',
            run_in_background: true,
          }),
        )
        .at(4_500)
        .appendJsonl(buildUserToolResultRecord('toolu-b8-off-agent'))
        .at(4_900)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(8_000)
        .build(),
    });

    // External scanner runs on a 3s interval, so external adoption is bounded by
    // ~3s for the JSONL to be picked up + JSONL polling time for the tool_use line.
    // Bumped timeouts cover scanner phase + polling round under load (first scan
    // can be skipped if the test setup races the scanner's first tick).
    await expectOverlayVisible(frame, 'Subtask: Background basic subtask', 20_000);
    await expectOverlayCount(frame, 1, 10_000);
    await expectNoOverlay(frame, 'general-purpose', 2_000);

    // Stability check: ensure no late-fire misroutes the subagent as a teammate.
    await frame.waitForTimeout(5_000);
    await expectOverlayCount(frame, 1);
    await expectNoOverlay(frame, 'general-purpose', 2_000);
  });

  test('agentToolsClear fires at turn end via turn_duration JSONL record @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    // Cross-cutting invariant from the manual F5 matrix: when a turn ends
    // (turn_duration record), all active tool overlays must clear back to "Idle".
    // The test runs in hooks-off so it exercises the JSONL parser path; a regression
    // here would leave a ghost "Running: ..." overlay even after the turn ended.
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('turn-end agentToolsClear')
        .at(1_000)
        .appendJsonl(buildAssistantToolUseRecord('toolu-c4-bash', 'Bash', { command: 'npm test' }))
        .at(3_000)
        .appendJsonl(buildUserToolResultRecord('toolu-c4-bash'))
        .at(3_500)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(8_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    // First the active overlay should show the bash command.
    await expectOverlayVisible(panelFrame, 'Running: npm test', 8_000);

    // After tool_result + turn_duration, the overlay must revert to "Idle".
    await expectOverlayVisible(panelFrame, 'Idle', 8_000);
    await expectNoOverlay(panelFrame, 'Running: npm test', 2_000);
  });

  // Heuristic permission and text-idle timers are cancelled when an agent
  // is closed via the overlay X.
  //
  // Invariant: closing an agent must cancel its in-flight 7s permission and
  // 5s text-idle heuristic timers. If a timer fires after close and the
  // extension unconditionally broadcasts `agentToolPermission` (or
  // `agentStatus: waiting`) for the gone agent, the webview's handler runs
  // playPermissionSound() / playDoneSound() (see
  // webview-ui/src/hooks/useExtensionMessages.ts:354 and 341), which our
  // notificationSound.ts instrumentation records in
  // window.__pixelAgentsTestHooks.playedSounds.
  //
  // Uses EXTERNAL agent (no VS Code terminal) so the Pixel Agents panel
  // stays at full size, dodging the layout race that breaks
  // closeAgentFromOverlay after an internal spawn (same close-via-overlay
  // pattern used by the dismissal-cooldown lifecycle test in this file).
  //
  // This catches "hard" leaks (broadcast despite missing agent). "Soft" leaks
  // (timer fires but its callback no-ops because internal state is gone) are
  // invisible from the webview — they require extension-host instrumentation
  // and are out of scope here.
  test('heuristic permission timer is cancelled when an agent is closed via overlay @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'heuristic-timer-cancellation',
      scenario: claudeScenario('heuristic timer cancellation on close hooks off')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-c7', 'Bash', {
            command: 'npm test',
          }),
        )
        .holdOpenFor(20_000)
        .build(),
    });

    await expectOverlayCount(frame, 1, 12_000);
    await expectOverlayVisible(frame, 'Running: npm test');
    const [agentId] = await readAgentOverlayIds(frame);

    await closeAgentFromOverlay(frame, { agentId });
    await expectOverlayCount(frame, 0, 8_000);

    // Reset AFTER close so only post-close sounds count as leaks.
    await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    // Wait longer than the 7s permission timer + cushion. If a timer leaked,
    // the broadcast lands during this window.
    await frame.waitForTimeout(9_000);

    await expectOverlayCount(frame, 0);
    const playedKinds = await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: Array<{ kind: string }> };
      };
      return (w.__pixelAgentsTestHooks?.playedSounds ?? []).map((s) => s.kind);
    });
    expect(playedKinds).not.toContain('permission');
    expect(playedKinds).not.toContain('done');
  });

  // Sub-agent permission bubble fires when a sub-agent runs a non-exempt
  // tool with no follow-up data for ~5s. The heuristic permission timer is
  // active for sub-agents in hooks-OFF mode (same path as parent agents).
  //
  // Trigger sequence:
  // 1. Parent agent does Task tool_use -> sub-character appears.
  // 2. A progress record arrives with a sub-agent tool_use for a non-exempt
  //    tool (Bash). transcriptParser registers the sub-tool and starts the
  //    permission timer.
  // 3. ~5s with no further sub-agent data -> permission bubble appears on
  //    both parent and sub-character (per CLAUDE.md "Sub-agent permission
  //    detection" note).
  test('sub-agent permission bubble fires on stalled non-exempt sub-tool via heuristic timer @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    const parentToolId = 'toolu-c14-task';
    const subToolId = 'toolu-c14-bash-sub';

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('sub-agent permission bubble hooks off')
        .at(2_000)
        .appendJsonl(
          buildAssistantToolUseRecord(parentToolId, 'Task', {
            description: 'permission subtask',
          }),
        )
        .at(3_000)
        .appendJsonl({
          type: 'progress',
          parentToolUseID: parentToolId,
          data: {
            type: 'agent_progress',
            message: {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'tool_use',
                    id: subToolId,
                    name: 'Bash',
                    input: { command: 'npm test' },
                  },
                ],
              },
            },
          },
        })
        // Hold open WAY past the 5s heuristic permission timer so the bubble
        // has time to appear before mock-claude exits and the terminal closes.
        .holdOpenFor(15_000)
        .build(),
    );

    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    expect(spawned.sessionId).toBeTruthy();
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    // Sub-character appears once the Task tool_use is parsed.
    await expectOverlayCount(panelFrame, 2, 12_000);
    await expectOverlayVisible(panelFrame, 'Subtask: permission subtask');

    // The "Subtask: permission subtask" overlay above already resolves the
    // moment the Task tool_use is parsed (scenario t=2s), but the heuristic
    // permission timer only starts when the sub-tool tool_use lands in the
    // progress record (scenario t=3s). The timer is PERMISSION_TIMER_DELAY_MS
    // (7s), and broadcast-to-DOM takes another ~300ms (transport + React
    // render). So this wait must cover: 1s scenario gap + 7s timer + slop.
    await expectOverlayVisible(panelFrame, 'Needs approval', 10_000);
  });
});
