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
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging a /clear — old session ends, a new one runs "npm test", a stale tool hits the old JSONL',
    );
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
    narrator.check('one character on screen before the /clear');

    narrator.step('waiting for the reassigned character to run the new session');
    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('same character shows "Running: npm test" — reassigned, count still 1');

    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('stale "npm run stale" never rendered; same single character throughout');
  });

  // In-terminal /resume: the SAME live claude process fires SessionEnd(resume)
  // then SessionStart(resume) with a new session id within milliseconds, so the
  // grace window reassigns the existing character. The CLI `claude --resume`
  // shape (old process gone, new one arrives later) is the "after the grace
  // window expires" test below.
  test('/resume reassigns the same agent within the grace window @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging an in-terminal /resume — session ends then restarts inside the 2s grace window',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/resume reassignment hooks on')
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
    narrator.check('one character on screen before the /resume');

    narrator.step('waiting for the resumed session to reuse the same character');
    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('same character shows "Running: npm test" within the grace window');

    // Settling wait: give the runtime a chance to wrongly attach the stale tool
    // to the resumed agent before asserting absence.
    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    narrator.check('stale "npm run stale" never attaches to the resumed agent');

    // Wait past the 2s resume grace window for the new tool to take effect.
    // expectOverlayVisible polls until the assertion holds; bumping the timeout
    // covers grace expiry + post-grace tool propagation.
    narrator.step('rechecking after the 2s grace window has expired');
    await expectOverlayVisible(panelFrame, 'Running: npm test', 5_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('still the same single character past the grace window');
  });

  test('/clear edge case with a sibling agent in the same projectDir @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external sibling session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging a /clear on the internal agent while a sibling shares its project dir',
    );
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
    narrator.check('internal agent on screen before the /clear (count 1)');

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

    narrator.step('waiting for both the internal agent and the sibling on screen (count → 2)');
    await expectOverlayCount(panelFrame, 2, 12_000);
    const externalAgentId = otherOverlayId(await readAgentOverlayIds(panelFrame), internalAgentId);
    narrator.check('two characters share the same project dir');

    await expectOverlayVisibleForAgent(panelFrame, externalAgentId, 'Running: npm run sibling');
    await expectOverlayVisibleForAgent(
      panelFrame,
      internalAgentId,
      'Running: npm run cleared',
      12_000,
    );
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([internalAgentId, externalAgentId]);
    narrator.check(
      'sibling keeps "npm run sibling", internal reassigns to "npm run cleared", stale never appears',
    );
  });

  test('--resume after the grace window expires cleans up the old agent @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
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

    narrator.step('waiting for the pre-resume tool to render');
    await expectOverlayVisible(frame, 'Running: npm run before-resume');
    const oldAgentId = await expectSingleAgentOverlay(frame);
    narrator.check('old character shows "Running: npm run before-resume"');

    narrator.step('resume arrives AFTER the grace window — the old character should be cleaned up');
    await expectOverlayCount(frame, 0, 8_000);
    narrator.check('old character removed (count → 0)');
    await expectOverlayVisible(frame, 'Running: npm run late-resume', 10_000);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);
    narrator.check('late-resumed session gets a NEW character with a different id');
  });

  test('three parallel Task subagents in one turn render distinct sub-characters @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('arranging one turn with three parallel Task tool_uses');
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

    narrator.step('waiting for all three parallel Subtask sub-characters to appear');
    await expectOverlayVisible(panelFrame, 'Subtask: Parallel task 3');
    await expectOverlayVisible(panelFrame, 'Parallel task 1');
    await expectOverlayVisible(panelFrame, 'Parallel task 2');
    await expectOverlayVisible(panelFrame, 'Parallel task 3');
    await expectOverlayCount(panelFrame, 4, 10_000);
    expect(await readAgentOverlayIds(panelFrame)).toHaveLength(4);
    narrator.check('parent + 3 subtasks on screen (count → 4)');

    narrator.step('after the batched tool_results + turn_duration, the subtasks should collapse');
    await expectOverlayCount(panelFrame, 1, 16_000);
    narrator.check('everything collapses back to just the parent (count → 1)');
  });

  test('inline teammate removed from team config disappears within one second @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('teammate-removal-hooks-on');
    narrator.step('seeding a team config with a lead + one inline teammate');
    const configPath = seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('the scenario rewrites the config to lead-only at t+8s');
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
    narrator.check('lead + teammate on screen; teammate shows "Searching the web" (count 2)');

    narrator.step('waiting for the 1s config poll to drop the removed teammate');
    await expectOverlayCount(panelFrame, 1, 12_000);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
    narrator.check('teammate gone within a second (count 2 → 1)');

    // Stability check: after cascade removal, the teammate must not reappear
    // (zombie cleanup race). Polling alone cannot test this; we have to wait.
    narrator.step('holding to confirm the teammate never reappears');
    await panelFrame.waitForTimeout(8_000);
    await expectOverlayCount(panelFrame, 1);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
    narrator.check('teammate stays gone through the stability window (count 1)');
  });

  test('lead SessionEnd cascade-removes active inline teammates @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('lead-cascade-hooks-on');

    narrator.step('enabling Watch All Sessions so the external lead session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    narrator.step('seeding a team of lead + two inline teammates');
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

    narrator.step('waiting for the lead + both teammates on screen (count → 3)');
    await expectOverlayCount(frame, 3, 12_000);
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE]);
    await expectOverlayVisibleWithTexts(frame, [SECOND_TEAMMATE_ROLE]);
    narrator.check('lead + both teammates on screen, each mid-tool (count 3)');

    narrator.step('lead emits SessionEnd — the whole trio should cascade away');
    await expectOverlayCount(frame, 0, 8_000);
    narrator.check('closing the lead cascades: all three gone (count → 0)');
  });

  test('external basic subagent with run_in_background routes to basic path @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external lead session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
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

    narrator.step('waiting for a basic Subtask sub-character (run_in_background, no team)');
    await expectOverlayVisible(frame, 'Subtask: Background basic subtask');
    await expectOverlayCount(frame, 1, 10_000);
    await expectNoOverlay(frame, 'general-purpose', 2_000);
    narrator.check(
      'basic "Subtask: Background basic subtask" shown; no "general-purpose" teammate overlay',
    );
    // Stability check: a misrouted SubagentStart could spawn a teammate-style
    // overlay seconds later (the lead has no teamName, so this is the regression).
    narrator.step('holding to confirm no teammate overlay spawns late');
    await frame.waitForTimeout(5_000);
    await expectOverlayCount(frame, 1);
    narrator.check('still just the basic subtask (count 1) — runInBackground gate holds');
  });

  test('lead permission_prompt routes bubble to teammate not lead when teammates exist @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('teammate-permission-hooks-on');

    narrator.step('enabling Watch All Sessions so the external lead session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    narrator.step('seeding a team of lead + one inline teammate');
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

    narrator.step('waiting for the teammate on screen doing the WebSearch');
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE], 12_000);
    narrator.check('teammate is up and working');

    narrator.step(
      'a permission_prompt arrives on the LEAD — the bubble should land on the working teammate',
    );
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE, 'Needs approval'], 8_000);
    await expectNoOverlayWithTexts(frame, ['LEAD', 'Needs approval']);
    narrator.check('"Needs approval" is on the teammate; the lead has no bubble');

    narrator.step('waiting for the teammate to finish its task');
    await expectNoOverlayWithTexts(frame, [INLINE_TEAMMATE_ROLE, 'Needs approval'], 8_000);
    narrator.check('bubble clears when the teammate completes');
  });

  test('TeammateIdle marks only the targeted teammate done and leaves lead unchanged @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('targeted-teammate-idle-hooks-on');

    narrator.step('enabling Watch All Sessions so the external lead session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    narrator.step('seeding a team of lead + two inline teammates');
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

    narrator.step('waiting for the lead + two teammates on screen (count → 3)');
    await expectOverlayCount(frame, 3, 12_000);
    narrator.check('lead + two teammates on screen (count 3)');

    narrator.step('a TeammateIdle hook targets only the first teammate and marks it Done');
    await expect
      .poll(
        async () =>
          frame.evaluate((agentName) => {
            const w = window as Window & {
              __pixelAgentsTestHooks?: {
                getCharacters?: () => Array<{
                  agentName?: string;
                  bubbleType: 'permission' | 'waiting' | null;
                  waitingAwaitingInput?: boolean;
                }>;
              };
            };
            return w.__pixelAgentsTestHooks
              ?.getCharacters?.()
              .find((ch) => ch.agentName === agentName);
          }, INLINE_TEAMMATE_ROLE),
        { timeout: 8_000 },
      )
      .toMatchObject({ bubbleType: 'waiting', waitingAwaitingInput: false });
    await expectOverlayVisibleWithTexts(frame, [SECOND_TEAMMATE_ROLE, 'Running: npm run reviewer']);
    await expectNoOverlayWithTexts(frame, [INLINE_TEAMMATE_ROLE, 'Waiting for input']);
    await expectNoOverlayWithTexts(frame, [SECOND_TEAMMATE_ROLE, 'Waiting for input']);
    await expectNoOverlayWithTexts(frame, ['LEAD', 'Waiting for input']);
    narrator.check(
      'first teammate exposes the Done checkmark; second still "Running: npm run reviewer"; lead unaffected',
    );
  });

  test('rapid /clear then new tool within 500ms lands on the reassigned agent @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging a time-compressed /clear — end, restart, fresh tool + a ghost tool all within ~500ms',
    );
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
    narrator.check('one character before the rapid /clear');

    narrator.step('waiting for the reassigned character to land on the fresh tool');
    await expectOverlayVisible(panelFrame, 'Running: npm run fresh');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('same character shows "Running: npm run fresh", count 1');

    await panelFrame.waitForTimeout(750);
    await expectNoOverlay(panelFrame, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('ghost "npm run ghost" never renders; id unchanged');
  });

  test('close via X prevents re-adoption of old JSONL during dismissal cooldown @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so external sessions are adopted');
    await setSettings(frame, {
      watchAllSessions: true,
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

    narrator.step('waiting for the external agent to be active');
    await expectOverlayVisible(frame, 'Running: npm run old-live');
    const oldAgentId = await expectSingleAgentOverlay(frame);
    narrator.check('external agent shows "Running: npm run old-live"');
    await closeAgentFromOverlay(frame, { agentId: oldAgentId });
    await expectOverlayCount(frame, 0, 8_000);
    narrator.check('agent removed after the "×" (count → 0)');

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

    narrator.step('waiting for the fresh external session to appear');
    await expectOverlayVisible(frame, 'Running: npm run reopened', 10_000);
    await expectOverlayCount(frame, 1);
    const [newAgentId] = await readAgentOverlayIds(frame);
    expect(newAgentId).not.toBe(oldAgentId);
    narrator.check('the fresh session gets a NEW character (count 1)');

    // Stability check: the closed JSONL must NOT be re-adopted during the 3-min
    // cooldown. 4s is enough to cover several scanner ticks.
    narrator.step(
      'holding while the dismissed JSONL gets a late stale write that must not be re-adopted',
    );
    await frame.waitForTimeout(4_000);
    await expectNoOverlay(frame, 'Running: npm run old-stale', 2_000);
    await expectOverlayCount(frame, 1);
    narrator.check('closed JSONL never re-adopted during cooldown; count stays 1');
  });

  // verify playDoneSound() fires on agentStatus: 'waiting'.
  // The webview's notificationSound.ts records every invocation into
  // window.__pixelAgentsTestHooks.playedSounds (a test-only marker that runs BEFORE the
  // soundEnabled gate). We trigger waiting state by sending an idle_prompt
  // notification hook (the same hook path the spawn-paths test uses to surface "Might be waiting for
  // input") and assert the sound was dispatched.
  test('done sound chime fires on agentStatus waiting @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
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
    narrator.check('external agent active — "Running: npm test"');

    // Reset the marker AFTER active-state dispatch so we only capture sounds
    // triggered by the idle_prompt under test.
    await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    narrator.step('sending an idle_prompt to flip the agent to waiting');
    await sendHookEvent(serverConfig, idlePrompt(sessionId));
    await expectOverlayVisible(frame, 'Waiting for input');
    narrator.check('overlay shows "Waiting for input"');

    narrator.step(
      'checking a "done" chime was dispatched (test hook — the chime is not audible in the video)',
    );
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
    narrator.check('playedSounds contains a "done" entry');
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
    const { window, tmpHome, mockLogFile, narrator } = pixelAgents;
    let frame = pixelAgents.frame;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step('spawning an agent, then closing + reopening the panel to force a fresh restore');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('restored agents skip spawn effect').holdOpenFor(20_000).build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);
    await expectOverlayCount(frame, 1);
    narrator.check('one agent after the initial spawn');

    // Let the original spawn animation finish so we don't confuse it with
    // the post-restore observation (matrix effect lives ~300ms; 800ms cushion).
    await frame.waitForTimeout(800);

    narrator.step(
      'closing the panel (disposes the webview) then reopening to restore existingAgents',
    );
    await closeBottomPanel(window);
    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);

    // The fresh webview has an empty addAgentLog. Wait until restoreAgents has
    // run (existingAgents → layoutLoaded → addAgent), then read the log. The
    // log captures matrixEffect AT addAgent time (synchronous inside the
    // wrapper), so it's immune to the ~300ms matrix-effect lifetime race that
    // would let a regression slip past a snapshot-based observable.
    narrator.step(
      'the whole signal is a test-hook read: every restored agent must skip the spawn effect',
    );
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
    narrator.check('every restored agent created with skipSpawnEffect=true and no matrix effect');
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
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    await waitForClaudeHookSetup(tmpHome);
    await waitForHookServer(tmpHome);
    const sessionId = 'tool-status-matrix-session';

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

    // Scenario-driven with 3s per tool phase (Pablo's review call, same rationale
    // as the spawn-paths external test): each PostToolUse clears the prior tool,
    // the paired PreToolUse 150ms later swaps in the next one, and the 3s phase
    // keeps every label on screen long enough for the run video AND gives the
    // polling assertions seconds of slack. The first Bash phase runs t+0.7s→5s
    // because the external-monitor terminal opens (~2-3s) before assertions start.
    const scenarioBuilder = claudeScenario('tool status text matrix')
      .at(200)
      .emitHook(
        sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<string, unknown>,
      )
      .at(700)
      .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>);
    const CASE_BASE_MS = 5_000;
    const CASE_PHASE_MS = 3_000;
    cases.forEach((c, index) => {
      const atMs = CASE_BASE_MS + index * CASE_PHASE_MS;
      scenarioBuilder
        .at(atMs)
        .emitHook({ session_id: sessionId, hook_event_name: 'PostToolUse' })
        .at(atMs + 150)
        .emitHook({
          session_id: sessionId,
          hook_event_name: 'PreToolUse',
          tool_name: c.toolName,
          tool_input: c.toolInput,
        });
    });
    const sessionEndAtMs = CASE_BASE_MS + cases.length * CASE_PHASE_MS + 500;
    scenarioBuilder
      .at(sessionEndAtMs)
      .emitHook(sessionEndExit(sessionId) as Record<string, unknown>)
      .holdOpenFor(sessionEndAtMs + 2_000);

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      scenario: scenarioBuilder.build(),
      sessionId,
    });

    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');
    narrator.check('agent active — "Running: npm test"');

    narrator.step('cycling through Read, Edit, Write, Glob, Grep, WebFetch — one tool every 3s');
    for (const c of cases) {
      await expectOverlayVisible(frame, c.expectedText);
    }
    narrator.check(
      'each tool shows its exact status: Reading foo.ts, Editing bar.ts, Writing baz.ts, Searching files/code, Fetching web content',
    );

    narrator.step('waiting for SessionEnd to remove the character');
    await expectOverlayCount(frame, 0);
    narrator.check('SessionEnd removes the character (count → 0)');
  });

  // verify playPermissionSound fires on agentToolPermission.
  // Companion to the done-sound test (which fires on agentStatus: waiting). The webview's permission
  // path is webview-ui/src/hooks/useExtensionMessages.ts:354 — same
  // playedSounds instrumentation as the done-chime test, just the other sound function.
  test('permission sound chime fires on agentToolPermission @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
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
    narrator.check('external agent active');

    // Reset the marker right before the action under test, so any earlier
    // sounds (none expected from the spawn, but defensive) are ignored.
    await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    narrator.step('sending a permissionRequest hook to raise the approval bubble');
    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectOverlayVisible(frame, 'Needs approval');
    narrator.check('"Needs approval" bubble is visible');

    narrator.step(
      'checking a "permission" chime was dispatched (test hook — not audible in the video)',
    );
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
    narrator.check('playedSounds contains a "permission" entry');
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
    const { tmpHome, narrator } = pixelAgents;

    narrator.step('reading ~/.claude/settings.json after startup — the hook must be installed');
    await waitForClaudeHookSetup(tmpHome);
    const settings = readClaudeSettings(tmpHome);

    // installHooks writes entries for every hook event the provider supports.
    // SessionStart and PreToolUse are the load-bearing ones; if those are present,
    // installation succeeded.
    expect(pixelAgentsHookPresent(settings, 'SessionStart')).toBe(true);
    expect(pixelAgentsHookPresent(settings, 'PreToolUse')).toBe(true);
    narrator.check(
      '~/.claude/settings.json has the pixel-agents hook under both SessionStart and PreToolUse',
    );
  });

  // toggling "Instant Detection" off uninstalls the pixel-agents hook;
  // toggling it back on reinstalls. Round-trip is idempotent (no duplicate
  // entries on the second install).
  test('hook install and uninstall round-trip via the Settings toggle @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    expect(pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse')).toBe(true);
    narrator.check('pixel-agents hook present under PreToolUse at startup');

    // Uninstall: toggle hooks off.
    narrator.step('toggling Hooks OFF in Settings — the hook entry should disappear');
    await setSettings(frame, { hooksEnabled: false });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(false);
    narrator.check('hook entry gone from settings.json after toggling off');

    // Reinstall: toggle hooks back on. hooksEnabled:true is the product
    // default, but here it is a mid-test ACTION (re-enable after the
    // uninstall above), not a redundant default — do not trim it.
    narrator.step('toggling Hooks back ON — the entry should reappear');
    await setSettings(frame, { hooksEnabled: true });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(true);
    narrator.check('hook entry back in settings.json after toggling on');

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
    narrator.check('exactly one pixel-agents entry — no duplicate installs');
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
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    await waitForClaudeHookSetup(tmpHome);
    await waitForHookServer(tmpHome);
    const sessionId = 'permission-bubble-clear-session';

    // Scenario-driven with ~4s phases (same rationale as the spawn-paths and
    // tool-status conversions): every state is visible in the run video and
    // narrated by the external-sessions monitor.
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: claudeScenario('permission bubble auto-clear')
        .at(200)
        .emitHook(
          sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
        .at(700)
        .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>)
        .at(4_500)
        .emitHook(permissionRequest(sessionId) as Record<string, unknown>)
        // Fresh PreToolUse without permissionActive must clear the bubble and
        // swap the overlay text to the new tool's status string.
        .at(8_500)
        .emitHook({ session_id: sessionId, hook_event_name: 'PostToolUse' })
        .at(8_650)
        .emitHook({
          session_id: sessionId,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/x/foo.ts' },
        })
        .holdOpenFor(13_000)
        .build(),
    });

    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');
    narrator.check('agent active — "Running: npm test"');

    await expectOverlayVisible(frame, 'Needs approval');
    narrator.check('"Needs approval" bubble is up');

    narrator.step('a fresh PreToolUse(Read) arrives, as if the user approved in the terminal');
    await expectOverlayVisible(frame, 'Reading foo.ts');
    await expectNoOverlay(frame, 'Needs approval', 2_000);
    narrator.check('overlay swaps to "Reading foo.ts"; the stale approval bubble is gone');
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
    const { window, narrator } = pixelAgents;
    let frame = pixelAgents.frame;

    // Read whatever the fixture default is, then flip it. The persistence
    // assertion is about the FLIPPED state surviving a reload, not about the
    // initial default value.
    const initial = await getSettingChecked(frame, 'Always Show Labels');
    narrator.step('flipping "Always Show Labels" in Settings');
    await setSettings(frame, { alwaysShowLabels: !initial });
    expect(await getSettingChecked(frame, 'Always Show Labels')).toBe(!initial);
    narrator.check('"Always Show Labels" is now flipped');

    // Force a fresh webview by closing and reopening the panel (same
    // mechanism the restored-agents test uses for the existingAgents restore path).
    narrator.step('closing + reopening the panel to force a fresh webview');
    await closeBottomPanel(window);
    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);

    // After settingsLoaded re-hydrates, the toggle must still be in the
    // flipped state — not back to the fixture default.
    expect(await getSettingChecked(frame, 'Always Show Labels')).toBe(!initial);
    narrator.check('flipped state survives the reload — persisted through config.json');
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
    const { frame, tmpHome, narrator } = pixelAgents;

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
    narrator.step('entering Layout mode');
    const layoutButton = frame.locator('button', { hasText: 'Layout' });
    await expect(layoutButton).toBeVisible({ timeout: 15_000 });
    await layoutButton.click();

    // Editor toolbar should reveal at least one tool button. Paint floor is
    // always present in the floor section of the toolbar.
    const paintFloorBtn = frame.locator('button[title="Paint floor tiles"]');
    await expect(paintFloorBtn).toBeVisible({ timeout: 10_000 });
    narrator.check('the layout editor toolbar is showing');
    narrator.step('selecting Paint floor and painting one tile');
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
    narrator.step('clicking Save — persisting the layout to disk');
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
    narrator.check('~/.pixel-agents/layout.json changed on disk after Save');

    // Exit edit mode and confirm the editor button disappears.
    narrator.step('exiting Layout mode');
    await layoutButton.click();
    await expect(paintFloorBtn).toBeHidden({ timeout: 5_000 });
    narrator.check('exiting Layout mode hides the editor toolbar');
  });

  // the regression that historically bit users. A third-party hook
  // entry pre-existing in settings.json must survive an uninstall of the
  // pixel-agents hook untouched.
  test('hook uninstall preserves a pre-existing third-party hook entry @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');

    // Inject a third-party hook entry alongside our install.
    narrator.step('planting a fake third-party hook next to the pixel-agents entry');
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
    narrator.check('both the pixel-agents and third-party hooks present before uninstall');

    // Uninstall via Settings toggle.
    narrator.step('toggling Hooks OFF — only the pixel-agents entry should be removed');
    await setSettings(frame, { hooksEnabled: false });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(false);
    narrator.check('pixel-agents hook removed from settings.json');

    // The third-party hook must still be there.
    now = readClaudeSettings(tmpHome);
    expect(thirdPartyHookPresent(now, 'PreToolUse', THIRD_PARTY_MARKER)).toBe(true);
    narrator.check('the third-party hook survived — surgical uninstall');
  });
});
