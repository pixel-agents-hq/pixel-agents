import type { Frame } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnExternalClaudeScenario,
} from '../../../helpers/mock-claude';
import {
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisible,
  expectOverlayVisibleWithTexts,
} from '../../../helpers/office';
import {
  buildAssistantToolUseRecord,
  buildAsyncAgentLaunchResultRecord,
  buildTeamMetadataRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
  seedTeamConfig,
} from '../../../helpers/team';
import {
  INLINE_TEAMMATE_ALIAS,
  INLINE_TEAMMATE_ROLE,
  TMUX_TEAMMATE_ALIAS,
  uniqueTeamName,
  withInlineTeammateSession,
  withTmuxTeammateSession,
} from '../../../helpers/lifecycle';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

async function expectLeadActivity(frame: Frame, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(frame, ['LEAD', text]);
  await expectNoOverlayWithTexts(frame, [INLINE_TEAMMATE_ROLE, text]);
}

async function expectTeammateActivity(frame: Frame, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE, text]);
  await expectNoOverlayWithTexts(frame, ['LEAD', text]);
}

async function expectExternalAgentAdoption(frame: Frame): Promise<void> {
  await expectOverlayCount(frame, 1, 10_000);
}

test.describe('Hooks OFF / matrix', () => {
  test('internal basic spawn adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('turning hooks OFF — adoption must come purely from JSONL polling');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step('scripting the mock: a Task tool_use, its result, then turn_duration');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('internal basic spawn hooks off')
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a2-task', 'Task', {
            description: 'Delegate research',
          }),
        )
        .at(8_000)
        .appendJsonl(buildUserToolResultRecord('toolu-a2-task'))
        .at(8_500)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(11_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    const terminalTab = window.getByText(/Claude Code #\d+/);
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });
    narrator.check('the Claude Code terminal tab is visible');
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('watching the office — the launched session should be adopted by polling');
    await expectOverlayCount(panelFrame, 1);
    narrator.check('exactly one character adopted via JSONL polling (count → 1)');
  });

  test('internal inline teammate adopted via JSONL polling @area:matrix', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-internal-inline');

    narrator.step('turning hooks OFF — the team must be discovered from JSONL alone');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step('seeding the team config: a lead plus a web-researcher teammate');
    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);
    narrator.step('scripting team-metadata records for the lead and teammate into JSONL');
    await arrangeNextClaudeInvocation(
      tmpHome,
      withInlineTeammateSession(claudeScenario('internal inline teammate hooks off'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(2_000)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(3_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a4-lead-bash', 'Bash', {
            command: 'npm test',
          }),
        )
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a4-teammate-search', 'WebSearch', {
            query: 'pixel agents',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .holdOpenFor(10_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    narrator.check('the LEAD character renders');
    narrator.step('expecting the web-researcher teammate to appear from JSONL polling');
    await expectOverlayCount(panelFrame, 2, 10_000);
    await expectOverlayVisibleWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE]);
    narrator.check('web-researcher teammate joined — 2 characters in the office');
    await expectLeadActivity(panelFrame, 'Running: npm test');
    narrator.check('"Running: npm test" on the lead only');
    await expectTeammateActivity(panelFrame, 'Searching the web');
    narrator.check('"Searching the web" on the teammate only');
  });

  test('internal tmux teammate adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-internal-tmux');

    narrator.step('turning hooks OFF — the tmux teammate must be found via JSONL polling');
    await setSettings(frame, {
      hooksEnabled: false,
    });

    narrator.step('seeding the team config: a lead plus a web-researcher teammate');
    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);
    narrator.step('scripting lead and separate tmux-teammate JSONL activity');
    await arrangeNextClaudeInvocation(
      tmpHome,
      withTmuxTeammateSession(claudeScenario('internal tmux teammate hooks off'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(4_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a6-team-spawn', 'Agent', {
            description: 'Delegate research',
            run_in_background: true,
          }),
        )
        .at(4_400)
        .appendJsonl(buildAsyncAgentLaunchResultRecord('toolu-a6-team-spawn'))
        .at(5_000)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: TMUX_TEAMMATE_ALIAS,
        })
        .at(8_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a6-lead-bash', 'Bash', {
            command: 'npm test',
          }),
        )
        .at(8_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a6-teammate-search', 'WebSearch', {
            query: 'pixel agents',
          }),
          { session: TMUX_TEAMMATE_ALIAS },
        )
        .holdOpenFor(12_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    narrator.check('the LEAD character renders');
    narrator.step('waiting for the run_in_background Agent to surface a Subtask');
    await expectOverlayVisible(panelFrame, 'Subtask: Delegate research');
    narrator.check('"Subtask: Delegate research" appears');
    await expectOverlayCount(panelFrame, 2, 10_000);
    await expectOverlayVisibleWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE]);
    narrator.check('web-researcher teammate present — 2 characters in the office');
    await expectLeadActivity(panelFrame, 'Running: npm test');
    narrator.check('the lead owns "Running: npm test" only');
    await expectTeammateActivity(panelFrame, 'Searching the web');
    narrator.check('the separate tmux teammate owns "Searching the web" only');
  });

  test('external basic spawn adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;
    const sessionId = 'hooks-off-external-basic-session';

    narrator.step(
      'enabling Watch All Sessions, hooks OFF — an outside session adopted by the scanner',
    );
    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
    });

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: claudeScenario('external basic spawn hooks off')
        .at(6_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a8-task', 'Task', {
            description: 'External research',
          }),
        )
        .at(8_500)
        .appendJsonl(buildUserToolResultRecord('toolu-a8-task'))
        .at(9_000)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(12_000)
        .build(),
    });

    narrator.step('waiting for the 3s external scanner to adopt the session');
    await expectExternalAgentAdoption(frame);
    narrator.check('external session adopted (count → 1)');
    narrator.step('expecting the scripted Task to surface a Subtask');
    await expectOverlayVisible(frame, 'Subtask: External research', 10_000);
    narrator.check('"Subtask: External research" appears');
    await expectOverlayCount(frame, 2, 10_000);
    narrator.check('subtask on screen alongside the lead (count → 2)');
    narrator.step('waiting for the tool_result + turn_duration to retire the subtask');
    await expectOverlayCount(frame, 1, 12_000);
    narrator.check('subtask despawned — count back to 1');
  });

  test('external inline teammate adopted via JSONL polling @area:matrix', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-external-inline');
    const sessionId = 'hooks-off-external-inline-session';

    narrator.step('enabling Watch All Sessions, hooks OFF — external team discovered via JSONL');
    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
    });

    narrator.step('seeding the team config: a lead plus a web-researcher teammate');
    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: withInlineTeammateSession(claudeScenario('external inline teammate hooks off'))
        .at(5_000)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(6_500)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(8_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a10-lead-bash', 'Bash', {
            command: 'npm test',
          }),
        )
        .at(9_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a10-teammate-search', 'WebSearch', {
            query: 'pixel agents',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .holdOpenFor(14_000)
        .build(),
    });

    narrator.step('waiting for the external scanner to adopt the session');
    await expectExternalAgentAdoption(frame);
    narrator.check('external lead adopted (count → 1)');
    await expectOverlayVisibleWithTexts(frame, ['LEAD'], 10_000);
    narrator.check('the LEAD character renders');
    narrator.step('expecting the web-researcher teammate from JSONL team-metadata');
    await expectOverlayCount(frame, 2, 12_000);
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE]);
    narrator.check('web-researcher teammate joined — 2 characters in the office');
    await expectLeadActivity(frame, 'Running: npm test');
    narrator.check('"Running: npm test" on the lead only');
    await expectTeammateActivity(frame, 'Searching the web');
    narrator.check('"Searching the web" on the teammate only');
  });

  test('external tmux teammate adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-external-tmux');
    const sessionId = 'hooks-off-external-tmux-session';

    narrator.step('enabling Watch All Sessions, hooks OFF — external tmux team found via JSONL');
    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
    });

    narrator.step('seeding the team config: a lead plus a web-researcher teammate');
    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: withTmuxTeammateSession(claudeScenario('external tmux teammate hooks off'))
        .at(5_000)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(6_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a12-team-spawn', 'Agent', {
            description: 'Delegate research',
            run_in_background: true,
          }),
        )
        .at(7_000)
        .appendJsonl(buildAsyncAgentLaunchResultRecord('toolu-a12-team-spawn'))
        .at(8_000)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: TMUX_TEAMMATE_ALIAS,
        })
        .at(10_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a12-lead-bash', 'Bash', {
            command: 'npm test',
          }),
        )
        .at(10_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a12-teammate-search', 'WebSearch', {
            query: 'pixel agents',
          }),
          { session: TMUX_TEAMMATE_ALIAS },
        )
        .holdOpenFor(15_000)
        .build(),
    });

    narrator.step('waiting for the external scanner to adopt the session');
    await expectExternalAgentAdoption(frame);
    narrator.check('external lead adopted (count → 1)');
    await expectOverlayVisibleWithTexts(frame, ['LEAD'], 10_000);
    narrator.check('the LEAD character renders');
    narrator.step('waiting for the run_in_background Agent to surface a Subtask');
    await expectOverlayVisible(frame, 'Subtask: Delegate research', 10_000);
    narrator.check('"Subtask: Delegate research" appears');
    await expectOverlayCount(frame, 2, 12_000);
    await expectOverlayVisibleWithTexts(frame, [INLINE_TEAMMATE_ROLE]);
    narrator.check('web-researcher teammate present — 2 characters in the office');
    await expectLeadActivity(frame, 'Running: npm test');
    narrator.check('the lead owns "Running: npm test" only');
    await expectTeammateActivity(frame, 'Searching the web');
    narrator.check('the separate tmux teammate owns "Searching the web" only');
  });
});
