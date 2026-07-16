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
import {
  getPixelAgentsFrame,
  openPixelAgentsPanel,
  runCommand,
  setSettings,
} from '../../../helpers/webview';

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
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — /clear must be detected from the JSONL stream alone');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step('arranging /clear: new session file + /clear record, then "npm test"');
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
    narrator.check('one character on screen — our internal agent');

    narrator.step('waiting for "npm test" from the post-/clear file (12s poll window)');
    await expectOverlayVisible(panelFrame, 'Running: npm test', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('same character now shows "Running: npm test" — reassigned, not duplicated');

    narrator.step('the stale tool on the OLD file must never render');
    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('"npm run stale" never appeared — old file abandoned, id unchanged');
  });

  // Heuristic /resume reassignment at agent startup.
  //
  // Scenario: user clicks + Agent → terminal runs `claude --session-id <UUID>`,
  // but the user immediately types /resume (or aborts and runs claude --resume)
  // so the session generates a DIFFERENT id and writes to <other-id>.jsonl. The
  // expected <UUID>.jsonl NEVER materializes (withoutAutoInit models this). The
  // heuristic in adapters/vscode/agentManager.ts:177-211 polls for the expected
  // file at 1Hz; when pollCount > 10 and the expected file still doesn't exist,
  // it scans the project dir for any jsonl modified after agent creation and
  // reassigns the agent to the newest candidate — hence the replacement landing
  // at t+11s, just past the >10-poll threshold. Note this is a STARTUP fallback:
  // there is no grace window in heuristic mode (that's hooks-mode vocabulary),
  // and no conversation-content continuity is asserted — Pixel Agents tracks
  // session files, not transcript content.
  //
  // Coexists with the /clear content-disambiguation heuristic in
  // fileWatcher.ts:150-152 (which requires the literal "/clear</command-name>"
  // substring in the new JSONL to claim it as a /clear file); --resume traffic
  // doesn't carry that substring so the two heuristics route correctly.
  test('/resume at startup reassigns the same agent via JSONL polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — startup /resume fallback runs on JSONL polling only');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step(
      'arranging a resume: the expected file never appears; a different one shows up at t+11s',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/resume reassignment hooks off')
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
    narrator.check('one character seated for our agent');

    narrator.step('waiting past the >10-poll threshold for the heuristic to adopt the newest file');
    await expectOverlayVisible(panelFrame, 'Running: npm test', 16_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('same character reassigned to the resumed file — "npm test", same id, count 1');
  });

  test('/clear edge case with a sibling agent in the same projectDir via JSONL polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — two agents in one projectDir, only one does the /clear dance');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step('arranging the sibling: it just runs "npm run sibling" and never clears');
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
    narrator.check('sibling character on screen');

    narrator.step('arranging the clearing agent: /clear then "npm run cleared", plus a stale tool');
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
    narrator.step('waiting for both characters to be present');
    await expectOverlayCount(panelFrame, 2, 12_000);
    const clearingAgentId = otherOverlayId(await readAgentOverlayIds(panelFrame), siblingAgentId);
    narrator.check('two characters — the sibling + the clearing agent');

    await expectOverlayVisibleForAgent(panelFrame, clearingAgentId, 'Running: npm run cleared');
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    narrator.check('clearing agent shows "npm run cleared"; the stale tool never rendered');
    const overlayTexts = await readAgentOverlayTexts(panelFrame);
    const siblingOverlay = overlayTexts.find(({ id }) => id === siblingAgentId);
    expect(siblingOverlay).toBeDefined();
    expect(siblingOverlay?.text).not.toContain('npm run cleared');
    expect(siblingOverlay?.text).not.toContain('npm run stale');
    expect([...(await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b)]).toEqual([
      siblingAgentId,
      clearingAgentId,
    ]);
    narrator.check(
      'sibling kept its own text — adopted neither cleared nor stale; id set is the pair',
    );
  });

  test('/clear retains its character after the terminal editor moves @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step(
      'hooks OFF — keep two internal characters while one terminal moves during /clear',
    );
    await setSettings(frame, {
      hooksEnabled: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear terminal move sibling hooks off')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-move-sibling', 'Bash', {
            command: 'npm run sibling',
          }),
        )
        .holdOpenFor(16_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    let panelFrame = await getPixelAgentsFrame(window);
    const siblingAgentId = await expectSingleAgentOverlay(panelFrame);

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('/clear terminal move target hooks off')
        .defineSession('replacement', '{{sessionId}}-clear-moved')
        .at(3_500)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-moved-ready'), {
          session: 'replacement',
        })
        .at(3_550)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b2-move-fresh', 'Bash', {
            command: 'npm run moved-clear',
          }),
          { session: 'replacement' },
        )
        .holdOpenFor(16_000)
        .build(),
    );

    await spawnInternalAgentAndWait(panelFrame, tmpHome, mockLogFile);
    await expectOverlayCount(panelFrame, 2, 12_000);
    const clearingAgentId = otherOverlayId(await readAgentOverlayIds(panelFrame), siblingAgentId);
    narrator.check('captured the clearing character id before its terminal moves');
    const terminalTab = window.getByText(/Claude Code #\d+/).last();
    await expect(terminalTab).toBeVisible({ timeout: 15_000 });
    await terminalTab.click();
    narrator.step('moving the focused clearing terminal editor into the next group');
    await runCommand(window, 'View: Move Editor into Next Group');

    await openPixelAgentsPanel(window);
    panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 2, 12_000);

    await expectOverlayVisibleForAgent(panelFrame, clearingAgentId, 'Running: npm run moved-clear');
    narrator.step('holding beyond two 3s external-scanner ticks');
    await panelFrame.waitForTimeout(7_000);
    await expectOverlayCount(panelFrame, 2);
    expect([...(await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b)]).toEqual([
      siblingAgentId,
      clearingAgentId,
    ]);
    narrator.check('the moved terminal reused its character; no third external character appeared');
  });

  test('heuristic late --resume after stale cleanup prevents zombie agents @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step(
      'enabling Watch All Sessions + hooks OFF so an external session is adopted via polling',
    );
    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
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

    narrator.step('waiting for the external tool "npm run before-resume" to render');
    await expectOverlayVisible(frame, 'Running: npm run before-resume');
    const oldAgentId = await expectSingleAgentOverlay(frame);
    narrator.check('external character adopted — "Running: npm run before-resume"');

    narrator.step('its transcript was deleted — the stale checker should remove it (up to 45s)');
    await expectOverlayCount(frame, 0, 45_000);
    narrator.check('character gone — stale cleanup fired, no zombie left behind');

    narrator.step('a much later resume session starts — waiting for "npm run late-resume"');
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
    narrator.check('fresh character with a NEW id — the resume did not resurrect the old one');
  });

  test('three parallel Task subagents in one turn render distinct sub-characters via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — three parallel Task subagents detected by JSONL polling alone');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step(
      'arranging one batch record with three Task tool_uses, then results + turn_duration',
    );
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

    narrator.step('waiting for all three Subtask sub-characters to appear');
    await expectOverlayVisible(panelFrame, 'Subtask: Parallel task 3');
    await expectOverlayVisible(panelFrame, 'Parallel task 1');
    await expectOverlayVisible(panelFrame, 'Parallel task 2');
    await expectOverlayVisible(panelFrame, 'Parallel task 3');
    await expectOverlayCount(panelFrame, 4, 10_000);
    expect(await readAgentOverlayIds(panelFrame)).toHaveLength(4);
    narrator.check('all three parallel tasks render — count 4 (lead + 3 subtasks)');

    narrator.step('after the tool_results + turn_duration, the subtasks should collapse');
    await expectOverlayCount(panelFrame, 1, 16_000);
    narrator.check('back to a single character — count 1');
  });

  test('inline teammate removed from team config disappears within one second via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('teammate-removal-hooks-off');
    narrator.step('seeding a team config: lead + one inline teammate');
    const configPath = seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    narrator.step('hooks OFF — teammate lifecycle driven by JSONL metadata + 1s config polling');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step(
      'arranging: teammate joins and searches the web, then config is rewritten to lead-only at t+8s',
    );
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

    narrator.step('waiting for the teammate to be discovered from the team metadata');
    await expectOverlayVisibleWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 10_000);
    await expectOverlayVisible(panelFrame, 'Searching the web');
    await expectOverlayCount(panelFrame, 2, 10_000);
    narrator.check('teammate present and "Searching the web" — count 2');

    narrator.step('config now lead-only — the 1s poll should drop the teammate');
    await expectOverlayCount(panelFrame, 1, 12_000);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
    narrator.check('teammate gone within a second — back to count 1');

    // Stability check (heuristic mode): after the 1s team-config polling
    // removes the teammate, ensure it stays removed under continued polling.
    narrator.step('holding through an 8s stability window — the teammate must stay gone');
    await panelFrame.waitForTimeout(8_000);
    await expectOverlayCount(panelFrame, 1);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
    narrator.check('still count 1 after 8s — teammate did not flicker back');
  });

  test('rapid /clear then new tool within 500ms lands on the reassigned agent via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — a compressed /clear-then-tool race, detected from JSONL alone');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step(
      'arranging: /clear then "npm run fresh" within 500ms, plus a ghost tool on the old file',
    );
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
    narrator.check('one character for our agent');

    narrator.step('waiting for "npm run fresh" to land on the reassigned character');
    await expectOverlayVisible(panelFrame, 'Running: npm run fresh', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('"Running: npm run fresh" on the same character, id unchanged');

    narrator.step('the ghost tool from the old file must not appear');
    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
    narrator.check('no ghost tool — id still unchanged');
  });

  test('close via X prevents re-adoption of old JSONL during dismissal cooldown via polling @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions + hooks OFF — external session adopted via polling');
    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
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

    narrator.step('waiting for the external agent to show "npm run old-live"');
    await expectOverlayVisible(frame, 'Running: npm run old-live');
    const oldAgentId = await expectSingleAgentOverlay(frame);
    narrator.check('external character adopted — "Running: npm run old-live"');
    await closeAgentFromOverlay(frame, { agentId: oldAgentId });
    await expectOverlayCount(frame, 0, 8_000);
    narrator.check('character dismissed — count 0');

    narrator.step('a new session starts — its JSONL should get a fresh character');
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
    narrator.check('new character with a NEW id — the dismissed session was not re-adopted');

    // Stability check (heuristic mode): cover several external scanner ticks
    // (3s interval) to ensure the dismissed JSONL is not re-adopted.
    narrator.step('the dismissed file keeps growing — holding across several 3s scanner ticks');
    await frame.waitForTimeout(8_000);
    await expectNoOverlay(frame, 'Running: npm run old-stale', 2_000);
    await expectOverlayCount(frame, 1);
    narrator.check('"npm run old-stale" never re-adopted — still count 1');
  });

  test('external basic subagent with run_in_background but no teamName routes to basic path @area:lifecycle', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions + hooks OFF — a team-less lead read from JSONL');
    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
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
    narrator.step(
      'waiting for the run_in_background Agent to render as a basic Subtask (20s window)',
    );
    await expectOverlayVisible(frame, 'Subtask: Background basic subtask', 20_000);
    await expectOverlayCount(frame, 1, 10_000);
    await expectNoOverlay(frame, 'general-purpose', 2_000);
    narrator.check(
      '"Subtask: Background basic subtask" renders — no "general-purpose" teammate ghost',
    );

    // Stability check: ensure no late-fire misroutes the subagent as a teammate.
    narrator.step('holding to be sure no late fire misroutes it to the teammate path');
    await frame.waitForTimeout(5_000);
    await expectOverlayCount(frame, 1);
    await expectNoOverlay(frame, 'general-purpose', 2_000);
    narrator.check('still count 1, still no "general-purpose" ghost');
  });

  test('agentToolsClear fires at turn end via turn_duration JSONL record @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — turn-end clear exercised through the JSONL parser path');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    // Cross-cutting invariant from the manual F5 matrix: when a turn ends
    // (turn_duration record), all active tool overlays must clear back to "Idle".
    // The test runs in hooks-off so it exercises the JSONL parser path; a regression
    // here would leave a ghost "Running: ..." overlay even after the turn ended.
    narrator.step('arranging: a Bash tool, then tool_result + a turn_duration record');
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
    narrator.step('waiting for the active tool overlay');
    await expectOverlayVisible(panelFrame, 'Running: npm test', 8_000);
    narrator.check('"Running: npm test" while the tool is active');

    // After tool_result + turn_duration, the overlay must revert to "Idle".
    narrator.step('after the turn_duration, the overlay must revert to Idle');
    await expectOverlayVisible(panelFrame, 'Idle', 8_000);
    await expectNoOverlay(panelFrame, 'Running: npm test', 2_000);
    narrator.check('overlay back to "Idle" — no ghost "Running: npm test" left behind');
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
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step(
      'enabling Watch All Sessions + hooks OFF — external agent runs a tool that never replies',
    );
    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
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

    narrator.step(
      'waiting for the external agent whose Bash tool would arm the 7s permission timer',
    );
    await expectOverlayCount(frame, 1, 12_000);
    await expectOverlayVisible(frame, 'Running: npm test');
    const [agentId] = await readAgentOverlayIds(frame);
    narrator.check('external character present — "Running: npm test"');

    await closeAgentFromOverlay(frame, { agentId });
    await expectOverlayCount(frame, 0, 8_000);
    narrator.check('agent closed — count 0');

    // Reset AFTER close so only post-close sounds count as leaks.
    narrator.step('resetting the recorded-sounds log so only post-close sounds count');
    await frame.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    // Wait longer than the 7s permission timer + cushion. If a timer leaked,
    // the broadcast lands during this window.
    narrator.step('waiting out the 7s timer window — a leaked timer would fire a bubble/sound now');
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
    narrator.check('count still 0 and no "permission"/"done" sound recorded — timer was cancelled');
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
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — sub-agent permission handled by the heuristic timer');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    const parentToolId = 'toolu-c14-task';
    const subToolId = 'toolu-c14-bash-sub';

    narrator.step('arranging: a Task, then a sub-agent Bash that stalls with no further data');
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
    narrator.step('waiting for the Subtask sub-character to appear');
    await expectOverlayCount(panelFrame, 2, 12_000);
    await expectOverlayVisible(panelFrame, 'Subtask: permission subtask');
    narrator.check('"Subtask: permission subtask" on screen — count 2');

    // The "Subtask: permission subtask" overlay above already resolves the
    // moment the Task tool_use is parsed (scenario t=2s), but the heuristic
    // permission timer only starts when the sub-tool tool_use lands in the
    // progress record (scenario t=3s). The timer is PERMISSION_TIMER_DELAY_MS
    // (7s), and broadcast-to-DOM takes another ~300ms (transport + React
    // render). So this wait must cover: 1s scenario gap + 7s timer + slop.
    narrator.step('waiting out the 7s permission timer for the stalled sub-tool (~8–10s)');
    await expectOverlayVisible(panelFrame, 'Needs approval', 10_000);
    narrator.check('"Needs approval" bubble fired on the stalled sub-tool');
  });
});
