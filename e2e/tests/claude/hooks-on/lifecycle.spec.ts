import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  idlePrompt,
  notificationPermissionPrompt,
  permissionRequest,
  preToolUseAgent,
  preToolUseBash,
  sendHookEvent,
  sessionEndClear,
  sessionEndExit,
  sessionEndResume,
  sessionStartClear,
  sessionStartResume,
  sessionStartStartup,
  subagentStart,
  taskCompleted,
  teammateIdle,
  waitForHookServer,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  INLINE_TEAMMATE_ALIAS,
  INLINE_TEAMMATE_ROLE,
  uniqueTeamName,
  withInlineTeammateSession,
  withInlineTeammateSessions,
} from '../../../helpers/lifecycle';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  mockClaudeInitRecord,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
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
} from '../../../helpers/office';
import {
  buildAssistantToolUseBatchRecord,
  buildAssistantToolUseRecord,
  buildTeamConfig,
  buildTeamMetadataRecord,
  buildTurnDurationRecord,
  buildUserToolResultBatchRecord,
  buildUserToolResultRecord,
  getClaudeProjectDir,
  seedTeamConfig,
} from '../../../helpers/team';
import {
  closeBottomPanel,
  getPixelAgentsFrame,
  getSettingChecked,
  openPixelAgentsPanel,
  setSettings,
} from '../../../helpers/webview';

const PARALLEL_PARENT_TOOL_ID = 'toolu-b5-parent';
const SECOND_TEAMMATE_ALIAS = 'reviewer';
const SECOND_TEAMMATE_ROLE = 'reviewer';

function otherOverlayId(ids: number[], knownId: number): number {
  const otherId = ids.find((id) => id !== knownId);
  if (otherId === undefined) {
    throw new Error(`Expected an overlay id other than ${knownId}, got ${JSON.stringify(ids)}`);
  }
  return otherId;
}

test.describe('Hooks ON / lifecycle', () => {
  test('/clear on internal agent reassigns the same character to the new JSONL @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear reassignment hooks on')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(3_500)
        .emitHook(sessionEndClear('{{sessionId}}') as Record<string, unknown>)
        .at(3_600)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-ready'), {
          session: 'replacement',
        })
        .at(3_800)
        .emitHook(
          sessionStartClear(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(4_200)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm test') as Record<
            string,
            unknown
          >,
        )
        .at(4_800)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm run stale') as Record<string, unknown>)
        .holdOpenFor(7_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('--resume reassigns the same agent within the grace window @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('--resume reassignment hooks on')
        .defineSession('replacement', '{{sessionId}}-resume')
        .at(3_500)
        .emitHook(sessionEndResume('{{sessionId}}') as Record<string, unknown>)
        .at(3_600)
        .appendJsonl(mockClaudeInitRecord('mock-claude-resume-ready'), {
          session: 'replacement',
        })
        .at(3_800)
        .emitHook(
          sessionStartResume(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(4_200)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm test') as Record<
            string,
            unknown
          >,
        )
        .at(4_800)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm run stale') as Record<string, unknown>)
        .holdOpenFor(9_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    // Settling wait: give the runtime a chance to wrongly attach the stale tool
    // to the resumed agent before asserting absence.
    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');

    // Wait past the 2s resume grace window for the new tool to take effect.
    // expectOverlayVisible polls until the assertion holds; bumping the timeout
    // covers grace expiry + post-grace tool propagation.
    await expectOverlayVisible(panelFrame, 'Running: npm test', 5_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('/clear edge case with a sibling agent in the same projectDir @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear edge with sibling agent hooks on')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(7_000)
        .emitHook(sessionEndClear('{{sessionId}}') as Record<string, unknown>)
        .at(7_100)
        .appendJsonl(mockClaudeInitRecord('mock-claude-sibling-clear-ready'), {
          session: 'replacement',
        })
        .at(7_300)
        .emitHook(
          sessionStartClear(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(7_600)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm run cleared') as Record<
            string,
            unknown
          >,
        )
        .at(8_100)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm run stale') as Record<string, unknown>)
        .holdOpenFor(12_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const internalAgentId = await expectSingleAgentOverlay(panelFrame);

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'sibling-clear-edge',
      scenario: claudeScenario('sibling external session hooks on')
        .at(200)
        .emitHook(
          sessionStartStartup('sibling-clear-edge', '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
        .at(1_000)
        .emitHook(
          preToolUseBash('sibling-clear-edge', 'npm run sibling') as Record<string, unknown>,
        )
        .holdOpenFor(12_000)
        .build(),
    });

    await expectOverlayCount(panelFrame, 2, 12_000);
    const externalAgentId = otherOverlayId(await readAgentOverlayIds(panelFrame), internalAgentId);

    await expectOverlayVisibleForAgent(panelFrame, externalAgentId, 'Running: npm run sibling');
    await expectOverlayVisibleForAgent(
      panelFrame,
      internalAgentId,
      'Running: npm run cleared',
      12_000,
    );
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([internalAgentId, externalAgentId]);
  });

  test('--resume after the grace window expires cleans up the old agent @area:lifecycle', async ({
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
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'late-resume-old-session-hooks-on',
      scenario: claudeScenario('--resume after grace expires hooks on')
        .defineSession('replacement', 'late-resume-new-session-hooks-on')
        .at(200)
        .emitHook(
          sessionStartStartup(
            'late-resume-old-session-hooks-on',
            '{{cwd}}',
            '{{transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(900)
        .emitHook(
          preToolUseBash('late-resume-old-session-hooks-on', 'npm run before-resume') as Record<
            string,
            unknown
          >,
        )
        .at(2_200)
        .emitHook(sessionEndResume('late-resume-old-session-hooks-on') as Record<string, unknown>)
        .at(4_800)
        .appendJsonl(mockClaudeInitRecord('mock-claude-late-resume-ready'), {
          session: 'replacement',
        })
        .at(5_000)
        .emitHook(
          sessionStartResume(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(5_300)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm run late-resume') as Record<
            string,
            unknown
          >,
        )
        .holdOpenFor(9_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run before-resume');
    const oldAgentId = await expectSingleAgentOverlay(frame);

    await expectOverlayCount(frame, 0, 8_000);
    await expectOverlayVisible(frame, 'Running: npm run late-resume', 10_000);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);
  });

  test('three parallel Task subagents in one turn render distinct sub-characters @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('three parallel Task subagents in one turn hooks on')
        .at(300)
        .emitHook(
          sessionStartStartup('{{sessionId}}', '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
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

  test('inline teammate removed from team config disappears within one second @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('teammate-removal-hooks-on');
    const configPath = seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      withInlineTeammateSession(claudeScenario('inline teammate removed from config hooks on'))
        .at(300)
        .emitHook(
          sessionStartStartup('{{sessionId}}', '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
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

    // Stability check: after cascade removal, the teammate must not reappear
    // (zombie cleanup race). Polling alone cannot test this; we have to wait.
    await panelFrame.waitForTimeout(8_000);
    await expectOverlayCount(panelFrame, 1);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
  });

  test('lead SessionEnd cascade-removes active inline teammates @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('lead-cascade-hooks-on');

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE, SECOND_TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'lead-cascade-session-hooks-on',
      scenario: withInlineTeammateSessions(claudeScenario('lead SessionEnd cascade hooks on'), [
        { alias: INLINE_TEAMMATE_ALIAS, role: INLINE_TEAMMATE_ROLE },
        { alias: SECOND_TEAMMATE_ALIAS, role: SECOND_TEAMMATE_ROLE },
      ])
        .at(200)
        .emitHook(
          sessionStartStartup(
            'lead-cascade-session-hooks-on',
            '{{cwd}}',
            '{{transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(900)
        .emitHook(
          preToolUseAgent('lead-cascade-session-hooks-on', 'Delegate teammates') as Record<
            string,
            unknown
          >,
        )
        .at(1_100)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(1_300)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(1_300)
        .appendJsonl(buildTeamMetadataRecord(teamName, SECOND_TEAMMATE_ROLE), {
          session: SECOND_TEAMMATE_ALIAS,
        })
        .at(1_500)
        .emitHook(
          subagentStart('lead-cascade-session-hooks-on', INLINE_TEAMMATE_ROLE) as Record<
            string,
            unknown
          >,
        )
        .at(2_200)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b7-search', 'WebSearch', {
            query: 'pixel agents cascade removal',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .at(2_400)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b7-review', 'Bash', {
            command: 'npm run review',
          }),
          { session: SECOND_TEAMMATE_ALIAS },
        )
        .at(5_000)
        .emitHook(sessionEndExit('lead-cascade-session-hooks-on') as Record<string, unknown>)
        .holdOpenFor(8_000)
        .build(),
    });

    await expectOverlayCount(frame, 3, 12_000);
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE]);
    await expectOverlayVisibleWithTexts(frame, [SECOND_TEAMMATE_ROLE]);

    await expectOverlayCount(frame, 0, 8_000);
  });

  test('external basic subagent with run_in_background routes to basic path @area:lifecycle', async ({
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
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'external-background-subagent-hooks-on',
      scenario: claudeScenario('external basic background subagent hooks on')
        .at(200)
        .emitHook(
          sessionStartStartup(
            'external-background-subagent-hooks-on',
            '{{cwd}}',
            '{{transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(900)
        .emitHook(
          preToolUseAgent(
            'external-background-subagent-hooks-on',
            'Background basic subtask',
          ) as Record<string, unknown>,
        )
        .at(1_100)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b8-agent', 'Agent', {
            description: 'Background basic subtask',
            run_in_background: true,
          }),
        )
        .at(1_500)
        .emitHook(
          subagentStart('external-background-subagent-hooks-on', 'general-purpose') as Record<
            string,
            unknown
          >,
        )
        .at(4_500)
        .appendJsonl(buildUserToolResultRecord('toolu-b8-agent'))
        .at(4_900)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(7_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Subtask: Background basic subtask');
    await expectOverlayCount(frame, 1, 10_000);
    await expectNoOverlay(frame, 'general-purpose', 2_000);
    // Stability check: a misrouted SubagentStart could spawn a teammate-style
    // overlay seconds later (the lead has no teamName, so this is the regression).
    await frame.waitForTimeout(5_000);
    await expectOverlayCount(frame, 1);
  });

  test('lead permission_prompt routes bubble to teammate not lead when teammates exist @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('teammate-permission-hooks-on');

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'teammate-permission-session-hooks-on',
      scenario: withInlineTeammateSession(claudeScenario('teammate permission routing hooks on'))
        .at(200)
        .emitHook(
          sessionStartStartup(
            'teammate-permission-session-hooks-on',
            '{{cwd}}',
            '{{transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(900)
        .emitHook(
          preToolUseAgent(
            'teammate-permission-session-hooks-on',
            'Delegate teammate work',
          ) as Record<string, unknown>,
        )
        .at(1_100)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(1_300)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(1_500)
        .emitHook(
          subagentStart('teammate-permission-session-hooks-on', INLINE_TEAMMATE_ROLE) as Record<
            string,
            unknown
          >,
        )
        .at(2_200)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b9-search', 'WebSearch', {
            query: 'permission routing',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .at(3_500)
        .emitHook(
          notificationPermissionPrompt('teammate-permission-session-hooks-on') as Record<
            string,
            unknown
          >,
        )
        .at(5_200)
        .emitHook(
          taskCompleted('teammate-permission-session-hooks-on', INLINE_TEAMMATE_ROLE) as Record<
            string,
            unknown
          >,
        )
        .holdOpenFor(8_000)
        .build(),
    });

    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE], 12_000);
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE, 'Needs approval'], 8_000);
    await expectNoOverlayWithTexts(frame, ['LEAD', 'Needs approval']);
    await expectNoOverlayWithTexts(frame, [INLINE_TEAMMATE_ROLE, 'Needs approval'], 8_000);
  });

  test('TeammateIdle marks the targeted teammate waiting and leaves lead unchanged @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('targeted-teammate-idle-hooks-on');

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE, SECOND_TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'targeted-teammate-idle-session-hooks-on',
      scenario: withInlineTeammateSessions(claudeScenario('targeted teammate idle hooks on'), [
        { alias: INLINE_TEAMMATE_ALIAS, role: INLINE_TEAMMATE_ROLE },
        { alias: SECOND_TEAMMATE_ALIAS, role: SECOND_TEAMMATE_ROLE },
      ])
        .at(200)
        .emitHook(
          sessionStartStartup(
            'targeted-teammate-idle-session-hooks-on',
            '{{cwd}}',
            '{{transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(900)
        .emitHook(
          preToolUseAgent(
            'targeted-teammate-idle-session-hooks-on',
            'Delegate teammates',
          ) as Record<string, unknown>,
        )
        .at(1_100)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(1_300)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(1_300)
        .appendJsonl(buildTeamMetadataRecord(teamName, SECOND_TEAMMATE_ROLE), {
          session: SECOND_TEAMMATE_ALIAS,
        })
        .at(1_500)
        .emitHook(
          subagentStart('targeted-teammate-idle-session-hooks-on', INLINE_TEAMMATE_ROLE) as Record<
            string,
            unknown
          >,
        )
        .at(2_200)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b10-search', 'WebSearch', {
            query: 'specific teammate idle',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .at(2_400)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b10-review', 'Bash', {
            command: 'npm run reviewer',
          }),
          { session: SECOND_TEAMMATE_ALIAS },
        )
        .at(4_000)
        .emitHook(
          teammateIdle('targeted-teammate-idle-session-hooks-on', INLINE_TEAMMATE_ROLE) as Record<
            string,
            unknown
          >,
        )
        .holdOpenFor(8_000)
        .build(),
    });

    await expectOverlayCount(frame, 3, 12_000);
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE, 'Waiting for input'], 8_000);
    await expectOverlayVisibleWithTexts(frame, [SECOND_TEAMMATE_ROLE, 'Running: npm run reviewer']);
    await expectNoOverlayWithTexts(frame, [SECOND_TEAMMATE_ROLE, 'Waiting for input']);
    await expectNoOverlayWithTexts(frame, ['LEAD', 'Waiting for input']);
  });

  test('rapid /clear then new tool within 500ms lands on the reassigned agent @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('rapid clear then new tool under 500ms hooks on')
        .defineSession('replacement', '{{sessionId}}-clear-fast')
        .at(3_500)
        .emitHook(sessionEndClear('{{sessionId}}') as Record<string, unknown>)
        .at(3_600)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-fast-ready'), {
          session: 'replacement',
        })
        .at(3_650)
        .emitHook(
          sessionStartClear(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(3_775)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm run fresh') as Record<
            string,
            unknown
          >,
        )
        .at(3_925)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm run ghost') as Record<string, unknown>)
        .holdOpenFor(7_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm run fresh');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(750);
    await expectNoOverlay(panelFrame, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('close via X prevents re-adoption of old JSONL during dismissal cooldown @area:lifecycle', async ({
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
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId: 'dismissal-cooldown-old-session-hooks-on',
      scenario: claudeScenario(' dismissal cooldown hooks on old session')
        .at(200)
        .emitHook(
          sessionStartStartup(
            'dismissal-cooldown-old-session-hooks-on',
            '{{cwd}}',
            '{{transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(900)
        .emitHook(
          preToolUseBash('dismissal-cooldown-old-session-hooks-on', 'npm run old-live') as Record<
            string,
            unknown
          >,
        )
        .at(7_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b12-old-stale', 'Bash', {
            command: 'npm run old-stale',
          }),
        )
        .holdOpenFor(12_000)
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
      sessionId: 'dismissal-cooldown-new-session-hooks-on',
      scenario: claudeScenario(' dismissal cooldown hooks on new session')
        .at(200)
        .emitHook(
          sessionStartStartup(
            'dismissal-cooldown-new-session-hooks-on',
            '{{cwd}}',
            '{{transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(900)
        .emitHook(
          preToolUseBash('dismissal-cooldown-new-session-hooks-on', 'npm run reopened') as Record<
            string,
            unknown
          >,
        )
        .holdOpenFor(8_000)
        .build(),
    });

    await expectOverlayVisible(frame, 'Running: npm run reopened', 10_000);
    await expectOverlayCount(frame, 1);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).not.toBe(oldAgentId);

    // Stability check: the closed JSONL must NOT be re-adopted during the 3-min
    // cooldown. 4s is enough to cover several scanner ticks.
    await frame.waitForTimeout(4_000);
    await expectNoOverlay(frame, 'Running: npm run old-stale', 2_000);
    await expectOverlayCount(frame, 1);
  });

  // verify playDoneSound() fires on agentStatus: 'waiting'.
  // The webview's notificationSound.ts records every invocation into
  // window.__pixelAgentsSoundsPlayed (a test-only marker that runs BEFORE the
  // soundEnabled gate). We trigger waiting state by sending an idle_prompt
  // notification hook (the same hook path the spawn-paths test uses to surface "Might be waiting for
  // input") and assert the sound was dispatched.
  test('done sound chime fires on agentStatus waiting @area:cross-cutting', async ({
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
    const sessionId = 'done-chime-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      scenario: claudeScenario('done sound chime smoke').holdOpenFor(3_000).build(),
      sessionId,
    });

    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    // SessionStart registers the session with the hook server so that the next
    // event (PreToolUseBash) drives the agent visible rather than landing in the
    // pre-registration buffer (same pattern as the spawn-paths external test).
    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));

    // Drive the agent active first (so the waiting transition is a real state
    // change rather than a no-op on a never-active agent).
    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');

    // Reset the marker AFTER active-state dispatch so we only capture sounds
    // triggered by the idle_prompt under test.
    await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    await sendHookEvent(serverConfig, idlePrompt(sessionId));
    await expectOverlayVisible(frame, 'Waiting for input');

    await expect
      .poll(
        async () =>
          frame.evaluate(() => {
            const w = window as Window & {
              __pixelAgentsTestHooks?: { playedSounds?: Array<{ kind: string }> };
            };
            return (w.__pixelAgentsTestHooks?.playedSounds ?? []).map((s) => s.kind);
          }),
        { timeout: 5_000 },
      )
      .toContain('done');
  });

  // verify restored agents skip the matrix-rain spawn animation.
  //
  // Invariant: useExtensionMessages.ts:153 passes skipSpawnEffect=true when
  // creating characters from the existingAgents payload. If someone drops
  // that arg, restored agents would briefly show matrixEffect='spawn' for
  // ~300ms (the matrix rain animation), regressing the "instant restore" UX.
  //
  // Trigger: close the bottom panel, then reopen it. closeBottomPanel hides
  // the WebviewView; PixelAgentsViewProvider does not set
  // retainContextWhenHidden so VS Code disposes the webview. Reopening via
  // openPixelAgentsPanel re-runs resolveWebviewView, bootstraps a fresh
  // React app, sends webviewReady, and the extension's view provider
  // unconditionally calls sendExistingAgents on every webviewReady
  // (PixelAgentsViewProvider.ts:479).
  //
  // window.location.reload() does NOT work here: vscode-webview:// iframes
  // can't survive a content-level reload (the security token / CSP / API
  // binding break) — the panel renders broken text instead of the canvas.
  //
  // Observable: window.__pixelAgentsTestHooks.getCharacters() (exposed from
  // App.tsx) returns a snapshot of character.matrixEffect. Sample for 400ms
  // starting at first character observation post-restore. A broken impl
  // (skipSpawnEffect=false) would show 'spawn' in at least one early sample
  // because the matrix effect lives ~300ms before transitioning to null.
  test('restored agents skip the matrix spawn animation @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window, tmpHome, mockLogFile } = pixelAgents;
    let frame = pixelAgents.frame;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('restored agents skip spawn effect').holdOpenFor(20_000).build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);
    await expectOverlayCount(frame, 1);

    // Let the original spawn animation finish so we don't confuse it with
    // the post-restore observation (matrix effect lives ~300ms; 800ms cushion).
    await frame.waitForTimeout(800);

    await closeBottomPanel(window);
    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);

    // The fresh webview has an empty addAgentLog. Wait until restoreAgents has
    // run (existingAgents → layoutLoaded → addAgent), then read the log. The
    // log captures matrixEffect AT addAgent time (synchronous inside the
    // wrapper), so it's immune to the ~300ms matrix-effect lifetime race that
    // would let a regression slip past a snapshot-based observable.
    await expect
      .poll(
        async () =>
          frame.evaluate(() => {
            const w = window as Window & {
              __pixelAgentsTestHooks?: { addAgentLog?: unknown[] };
            };
            return w.__pixelAgentsTestHooks?.addAgentLog?.length ?? 0;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const log = await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: {
          addAgentLog?: Array<{
            id: number;
            skipSpawnEffect: boolean | undefined;
            matrixEffectAtCreation: string | null;
          }>;
        };
      };
      return w.__pixelAgentsTestHooks?.addAgentLog ?? [];
    });

    // Every addAgent call in this fresh webview comes from the restore path
    // (there's no agentCreated message between webview boot and our read).
    // Each must have skipSpawnEffect=true and matrixEffect=null at creation.
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) {
      expect(entry.skipSpawnEffect).toBe(true);
      expect(entry.matrixEffectAtCreation).toBeNull();
    }
  });

  // verify formatToolStatus produces the right overlay text for every
  // PreToolUse'd tool, not just Bash. Every other e2e test fires Bash and
  // asserts "Running: npm test"; the 9 other tool-name branches in
  // claudeProvider.formatToolStatus had zero direct coverage prior to this.
  //
  // Each entry below maps a hook payload (tool_name + tool_input) to the
  // expected overlay text. If formatToolStatus regresses, this test catches
  // it. The agent stays the same throughout; each PreToolUse swaps the
  // active tool text, and PostToolUse clears it before the next.
  test('tool status text matches every PreToolUse tool name @area:cross-cutting', async ({
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
    const sessionId = 'tool-status-matrix-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      scenario: claudeScenario('tool status text matrix').holdOpenFor(8_000).build(),
      sessionId,
    });

    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));

    // Drive the agent visible with a Bash tool first so the overlay exists.
    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');

    // Task / Agent tools follow the sub-character code path (covered by the basic-spawn test)
    // and don't change the parent overlay text — they're excluded here.
    // WebSearch returns "Searching the web" but is covered implicitly by
    // the same code branch as Glob/Grep; one Search variant is enough.
    type ToolCase = { toolName: string; toolInput: Record<string, unknown>; expectedText: string };
    const cases: ToolCase[] = [
      { toolName: 'Read', toolInput: { file_path: '/x/foo.ts' }, expectedText: 'Reading foo.ts' },
      { toolName: 'Edit', toolInput: { file_path: '/x/bar.ts' }, expectedText: 'Editing bar.ts' },
      { toolName: 'Write', toolInput: { file_path: '/x/baz.ts' }, expectedText: 'Writing baz.ts' },
      { toolName: 'Glob', toolInput: { pattern: '**/*.ts' }, expectedText: 'Searching files' },
      { toolName: 'Grep', toolInput: { pattern: 'foo' }, expectedText: 'Searching code' },
      {
        toolName: 'WebFetch',
        toolInput: { url: 'https://x' },
        expectedText: 'Fetching web content',
      },
    ];

    for (const c of cases) {
      // PostToolUse clears any prior tool's overlay; for the FIRST iteration this
      // clears the seed Bash overlay above.
      await sendHookEvent(serverConfig, {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
      });
      await sendHookEvent(serverConfig, {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: c.toolName,
        tool_input: c.toolInput,
      });
      await expectOverlayVisible(frame, c.expectedText);
    }

    await sendHookEvent(serverConfig, sessionEndExit(sessionId));
    await expectOverlayCount(frame, 0);
  });

  // verify playPermissionSound fires on agentToolPermission.
  // Companion to the done-sound test (which fires on agentStatus: waiting). The webview's permission
  // path is webview-ui/src/hooks/useExtensionMessages.ts:354 — same
  // playedSounds instrumentation as the done-chime test, just the other sound function.
  test('permission sound chime fires on agentToolPermission @area:cross-cutting', async ({
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
    const sessionId = 'permission-chime-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      scenario: claudeScenario('permission sound chime smoke').holdOpenFor(3_000).build(),
      sessionId,
    });

    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));
    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(frame, 1);

    // Reset the marker right before the action under test, so any earlier
    // sounds (none expected from the spawn, but defensive) are ignored.
    await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectOverlayVisible(frame, 'Needs approval');

    await expect
      .poll(
        async () =>
          frame.evaluate(() => {
            const w = window as Window & {
              __pixelAgentsTestHooks?: { playedSounds?: Array<{ kind: string }> };
            };
            return (w.__pixelAgentsTestHooks?.playedSounds ?? []).map((s) => s.kind);
          }),
        { timeout: 5_000 },
      )
      .toContain('permission');
  });

  // Hook installer side effects: claudeHookInstaller side effects on ~/.claude/settings.json.
  //
  // Background: when "Instant Detection (Hooks)" is toggled in Settings, the
  // extension writes (install) or rewrites (uninstall) ~/.claude/settings.json
  // via claudeHookInstaller. Historical bugs around clobbering pre-existing
  // third-party hook entries make this a real bug surface. Unit tests cover the
  // installer with mocked fs; this e2e covers the actual round-trip from
  // setSettings UI toggle → file on disk.
  //
  // Pixel-agents hook entries are recognised by the command string containing
  // 'claude-hook.js' (or legacy 'pixel-agents-hook.js'); see
  // server/src/providers/hook/claude/claudeHookInstaller.ts::isOurHookEntry.

  function readClaudeSettings(tmpHome: string): {
    hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  } {
    const p = path.join(tmpHome, '.claude', 'settings.json');
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return {};
    }
  }

  function pixelAgentsHookPresent(
    settings: ReturnType<typeof readClaudeSettings>,
    eventName: string,
  ): boolean {
    const entries = settings.hooks?.[eventName] ?? [];
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes('claude-hook.js') || h.command?.includes('pixel-agents-hook.js')) {
          return true;
        }
      }
    }
    return false;
  }

  function thirdPartyHookPresent(
    settings: ReturnType<typeof readClaudeSettings>,
    eventName: string,
    marker: string,
  ): boolean {
    const entries = settings.hooks?.[eventName] ?? [];
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes(marker)) return true;
      }
    }
    return false;
  }

  // the extension installs the pixel-agents hook on startup with the
  // default hooksEnabled=true. Sanity check — if this fails, claudeHookInstaller
  // never ran, and every other hooks-on test is operating against an empty
  // settings.json (i.e., hooks are silently no-op'd).
  test('pixel-agents hook is installed in settings.json on extension startup @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { tmpHome } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    const settings = readClaudeSettings(tmpHome);

    // installHooks writes entries for every hook event the provider supports.
    // SessionStart and PreToolUse are the load-bearing ones; if those are present,
    // installation succeeded.
    expect(pixelAgentsHookPresent(settings, 'SessionStart')).toBe(true);
    expect(pixelAgentsHookPresent(settings, 'PreToolUse')).toBe(true);
  });

  // toggling "Instant Detection" off uninstalls the pixel-agents hook;
  // toggling it back on reinstalls. Round-trip is idempotent (no duplicate
  // entries on the second install).
  test('hook install and uninstall round-trip via the Settings toggle @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    expect(pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse')).toBe(true);

    // Uninstall: toggle hooks off.
    await setSettings(frame, { hooksEnabled: false });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(false);

    // Reinstall: toggle hooks back on.
    await setSettings(frame, { hooksEnabled: true });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(true);

    // No duplication: exactly one pixel-agents entry across all PreToolUse hooks.
    const settings = readClaudeSettings(tmpHome);
    const preTool = settings.hooks?.['PreToolUse'] ?? [];
    const pixelAgentsCount = preTool.reduce((acc, entry) => {
      return (
        acc +
        (entry.hooks ?? []).filter(
          (h) =>
            h.command?.includes('claude-hook.js') || h.command?.includes('pixel-agents-hook.js'),
        ).length
      );
    }, 0);
    expect(pixelAgentsCount).toBe(1);
  });

  // permission bubble auto-clears when a fresh PreToolUse arrives.
  //
  // Implementation invariant: useExtensionMessages.ts:269 calls
  // os.clearPermissionBubble(id) on every agentToolStart unless
  // permissionActive=true is set on the new tool. Without this, the "Needs
  // approval" overlay would linger across tool transitions inside the same
  // session.
  test('permission bubble auto-clears when a fresh PreToolUse arrives @area:cross-cutting', async ({
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
    const sessionId = 'permission-bubble-clear-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      scenario: claudeScenario('permission bubble auto-clear').holdOpenFor(5_000).build(),
      sessionId,
    });

    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));
    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');

    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectOverlayVisible(frame, 'Needs approval');

    // Fresh PreToolUse without permissionActive should clear the bubble and
    // swap the overlay text to the new tool's status string.
    await sendHookEvent(serverConfig, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
    });
    await sendHookEvent(serverConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/x/foo.ts' },
    });
    await expectOverlayVisible(frame, 'Reading foo.ts');
    await expectNoOverlay(frame, 'Needs approval', 2_000);
  });

  // persisted settings survive a webview reload.
  //
  // The webview's settings UI is hydrated from `settingsLoaded` on every
  // `webviewReady`. The extension reads from its persisted state (workspace
  // and global state plus ~/.pixel-agents/config.json) and resends. A
  // regression in any of {FileStateAdapter.setSetting, configPersistence,
  // PixelAgentsViewProvider's webviewReady handler} would surface as "I
  // turned X off, restarted, X is back on."
  //
  // Trigger: toggle Always Show Labels off, close+reopen the panel (forces a
  // fresh webviewReady), open the Settings modal, read the indicator state.
  // It must still be unchecked.
  test('settings toggles persist across a webview reload @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window } = pixelAgents;
    let frame = pixelAgents.frame;

    // Read whatever the fixture default is, then flip it. The persistence
    // assertion is about the FLIPPED state surviving a reload, not about the
    // initial default value.
    const initial = await getSettingChecked(frame, 'Always Show Labels');
    await setSettings(frame, { alwaysShowLabels: !initial });
    expect(await getSettingChecked(frame, 'Always Show Labels')).toBe(!initial);

    // Force a fresh webview by closing and reopening the panel (same
    // mechanism the restored-agents test uses for the existingAgents restore path).
    await closeBottomPanel(window);
    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);

    // After settingsLoaded re-hydrates, the toggle must still be in the
    // flipped state — not back to the fixture default.
    expect(await getSettingChecked(frame, 'Always Show Labels')).toBe(!initial);
  });

  // layout editor smoke. Verifies entering edit mode reveals the editor
  // toolbar, that a save round-trips through layoutPersistence.ts to
  // ~/.pixel-agents/layout.json, and that exiting edit mode hides the toolbar.
  //
  // Strategy: click Layout button to enter edit mode -> assert a known
  // editor-only button is visible -> click on the canvas to dirty the layout
  // -> Save in EditActionBar -> read layout.json from disk and confirm it
  // grew/changed from the initial state -> exit edit mode -> assert the
  // editor button is gone.
  //
  // This deliberately doesn't assert any particular layout content beyond
  // "the saved file contains a layout the editor session produced." Canvas
  // pixel coordinates are not pinned because we only need ANY change to land
  // on disk to prove the round trip works.
  test('layout editor enter paint save persist and exit round-trip @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome } = pixelAgents;

    const layoutPath = path.join(tmpHome, '.pixel-agents', 'layout.json');

    // Initial layout — there should be one written at fixture startup since
    // the webview boots with a default layout. Record its content for the
    // post-save diff.
    let initialLayout = '';
    if (fs.existsSync(layoutPath)) {
      initialLayout = fs.readFileSync(layoutPath, 'utf8');
    }

    // Dismiss any first-run tooltips that overlay the top toolbar. The
    // "Instant Detection Active" tooltip and the "Updated to vN" tooltip
    // both intercept clicks on the Undo/Redo/Save row. We dismiss them via
    // their close buttons (the X) before entering edit mode.
    for (const tooltipText of ['Instant Detection Active', 'Updated to v']) {
      const tooltip = frame.locator('div', { hasText: tooltipText }).first();
      if (await tooltip.isVisible().catch(() => false)) {
        const closeBtn = tooltip.locator('button', { hasText: 'x' }).first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click().catch(() => {});
        }
      }
    }

    // Enter edit mode.
    const layoutButton = frame.locator('button', { hasText: 'Layout' });
    await expect(layoutButton).toBeVisible({ timeout: 15_000 });
    await layoutButton.click();

    // Editor toolbar should reveal at least one tool button. Paint floor is
    // always present in the floor section of the toolbar.
    const paintFloorBtn = frame.locator('button[title="Paint floor tiles"]');
    await expect(paintFloorBtn).toBeVisible({ timeout: 10_000 });
    await paintFloorBtn.click();

    // Click the canvas center — with paint floor active, this paints the
    // tile under the cursor and marks the layout dirty. The exact tile
    // doesn't matter; ANY dirty edit produces a save-eligible layout.
    const canvas = frame.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas has no bounding box');
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });

    // EditActionBar appears only when isDirty=true. Save button is part of it.
    const saveBtn = frame.locator('button', { hasText: 'Save' });
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();

    // Wait until layout.json reflects a change. The debounced save in
    // layoutPersistence writes atomically; poll the file for any content
    // delta from the initial snapshot.
    await expect
      .poll(
        () => {
          if (!fs.existsSync(layoutPath)) return false;
          return fs.readFileSync(layoutPath, 'utf8') !== initialLayout;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // Exit edit mode and confirm the editor button disappears.
    await layoutButton.click();
    await expect(paintFloorBtn).toBeHidden({ timeout: 5_000 });
  });

  // the regression that historically bit users. A third-party hook
  // entry pre-existing in settings.json must survive an uninstall of the
  // pixel-agents hook untouched.
  test('hook uninstall preserves a pre-existing third-party hook entry @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');

    // Inject a third-party hook entry alongside our install.
    const THIRD_PARTY_MARKER = '/usr/local/bin/third-party-hook.js';
    const settings = readClaudeSettings(tmpHome);
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks['PreToolUse']) settings.hooks['PreToolUse'] = [];
    settings.hooks['PreToolUse'].push({
      matcher: '',
      hooks: [{ command: THIRD_PARTY_MARKER }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Sanity: both entries present before uninstall.
    let now = readClaudeSettings(tmpHome);
    expect(pixelAgentsHookPresent(now, 'PreToolUse')).toBe(true);
    expect(thirdPartyHookPresent(now, 'PreToolUse', THIRD_PARTY_MARKER)).toBe(true);

    // Uninstall via Settings toggle.
    await setSettings(frame, { hooksEnabled: false });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(false);

    // The third-party hook must still be there.
    now = readClaudeSettings(tmpHome);
    expect(thirdPartyHookPresent(now, 'PreToolUse', THIRD_PARTY_MARKER)).toBe(true);
  });
});
