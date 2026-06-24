import type { Frame } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { uniqueTeamName } from '../../../helpers/lifecycle';
import {
  arrangeNextClaudeInvocation,
  type ClaudeMockScenarioBuilder,
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
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

const TEAMMATE_ROLE = 'web-researcher';
const TEAMMATE_ALIAS = 'teammate';
const TEAMMATE_SLUG = `agent-${TEAMMATE_ROLE}`;

function withTeammateSession(builder: ClaudeMockScenarioBuilder): ClaudeMockScenarioBuilder {
  return builder.defineSession(TEAMMATE_ALIAS, TEAMMATE_SLUG, {
    transcriptPathTemplate: `{{projectDir}}/{{sessionId}}/subagents/${TEAMMATE_SLUG}.jsonl`,
    sidecarPathTemplate: `{{projectDir}}/{{sessionId}}/subagents/${TEAMMATE_SLUG}.meta.json`,
    sidecarJson: {
      agentType: TEAMMATE_ROLE,
    },
  });
}

async function expectLeadActivity(frame: Frame, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(frame, ['LEAD', text]);
  await expectNoOverlayWithTexts(frame, [TEAMMATE_ROLE, text]);
}

async function expectTeammateActivity(frame: Frame, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE, text]);
  await expectNoOverlayWithTexts(frame, ['LEAD', text]);
}

async function expectExternalAgentAdoption(frame: Frame): Promise<void> {
  await expectOverlayCount(frame, 1, 10_000);
}

test.describe('Hooks OFF / matrix', () => {
  test('internal basic spawn adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

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
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayCount(panelFrame, 1);
  });

  test('internal inline teammate adopted via JSONL polling @area:matrix', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-internal-inline');

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await arrangeNextClaudeInvocation(
      tmpHome,
      withTeammateSession(claudeScenario('internal inline teammate hooks off'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(2_000)
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: TEAMMATE_ALIAS,
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
          { session: TEAMMATE_ALIAS },
        )
        .holdOpenFor(10_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    await expectOverlayCount(panelFrame, 2, 10_000);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);
    await expectLeadActivity(panelFrame, 'Running: npm test');
    await expectTeammateActivity(panelFrame, 'Searching the web');
  });

  test('internal tmux teammate adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-internal-tmux');

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await arrangeNextClaudeInvocation(
      tmpHome,
      withTeammateSession(claudeScenario('internal tmux teammate hooks off'))
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
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: TEAMMATE_ALIAS,
        })
        .at(8_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a6-lead-bash', 'Bash', {
            command: 'npm test',
          }),
        )
        .holdOpenFor(12_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    await expectOverlayVisible(panelFrame, 'Subtask: Delegate research');
    await expectOverlayCount(panelFrame, 2, 10_000);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);
    await expectLeadActivity(panelFrame, 'Running: npm test');
  });

  test('external basic spawn adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;
    const sessionId = 'hooks-off-external-basic-session';

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

    await expectExternalAgentAdoption(frame);
    await expectOverlayVisible(frame, 'Subtask: External research', 10_000);
    await expectOverlayCount(frame, 2, 10_000);
    await expectOverlayCount(frame, 1, 12_000);
  });

  test('external inline teammate adopted via JSONL polling @area:matrix', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-external-inline');
    const sessionId = 'hooks-off-external-inline-session';

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: withTeammateSession(claudeScenario('external inline teammate hooks off'))
        .at(5_000)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(6_500)
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: TEAMMATE_ALIAS,
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
          { session: TEAMMATE_ALIAS },
        )
        .holdOpenFor(14_000)
        .build(),
    });

    await expectExternalAgentAdoption(frame);
    await expectOverlayVisibleWithTexts(frame, ['LEAD'], 10_000);
    await expectOverlayCount(frame, 2, 12_000);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);
    await expectLeadActivity(frame, 'Running: npm test');
    await expectTeammateActivity(frame, 'Searching the web');
  });

  test('external tmux teammate adopted via JSONL polling @area:matrix', async ({ pixelAgents }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('hooks-off-external-tmux');
    const sessionId = 'hooks-off-external-tmux-session';

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: withTeammateSession(claudeScenario('external tmux teammate hooks off'))
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
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: TEAMMATE_ALIAS,
        })
        .at(10_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a12-lead-bash', 'Bash', {
            command: 'npm test',
          }),
        )
        .holdOpenFor(15_000)
        .build(),
    });

    await expectExternalAgentAdoption(frame);
    await expectOverlayVisibleWithTexts(frame, ['LEAD'], 10_000);
    await expectOverlayVisible(frame, 'Subtask: Delegate research', 10_000);
    await expectOverlayCount(frame, 2, 12_000);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);
    await expectLeadActivity(frame, 'Running: npm test');
  });
});
