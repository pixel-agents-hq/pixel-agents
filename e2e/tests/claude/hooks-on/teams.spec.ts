import type { Frame } from '@playwright/test';

import { test } from '../../../fixtures/pixel-agents';
import {
  permissionRequest,
  preToolUseAgent,
  preToolUseBash,
  sessionStartStartup,
  subagentStart,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  INLINE_TEAMMATE_ALIAS,
  uniqueTeamName,
  withInlineTeammateSession,
} from '../../../helpers/lifecycle';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import {
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisibleWithTexts,
} from '../../../helpers/office';
import {
  buildAssistantToolUseRecord,
  buildTeamMetadataRecord,
  seedTeamConfig,
} from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

const TEAMMATE_ROLE = 'web-researcher';

async function expectLeadActivity(frame: Frame, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(frame, ['LEAD', text]);
  await expectNoOverlayWithTexts(frame, [TEAMMATE_ROLE, text]);
}

async function expectTeammateActivity(frame: Frame, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE, text]);
  await expectNoOverlayWithTexts(frame, ['LEAD', text]);
}

// All four tests are scenario-driven (mocking rule 1) with ~3s phases so run
// videos show each routing step and the mock narrates it — in the Claude Code
// terminal for internal leads, in the external-sessions monitor for external
// ones. TEAMMATE_ROLE equals INLINE_TEAMMATE_ROLE in helpers/lifecycle.ts, so
// withInlineTeammateSession provides the teammate transcript + .meta.json
// sidecar exactly like the old createTeammateTranscript test-body helper did.
test.describe('Hooks ON / teams', () => {
  test('internal terminal lead with inline teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    const teamName = uniqueTeamName('hooks-on-internal-inline');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      withInlineTeammateSession(claudeScenario('internal inline teammate routing hooks on'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(3_000)
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(3_500)
        .emitHook(preToolUseAgent('{{sessionId}}', 'Delegate research') as Record<string, unknown>)
        .at(4_000)
        .emitHook(subagentStart('{{sessionId}}', TEAMMATE_ROLE) as Record<string, unknown>)
        .at(7_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a3-lead-bash', 'Bash', { command: 'npm test' }),
        )
        .at(10_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a3-teammate-search', 'WebSearch', {
            query: 'pixel agents',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .holdOpenFor(14_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);
    await expectLeadActivity(panelFrame, 'Running: npm test');
    await expectTeammateActivity(panelFrame, 'Searching the web');
  });

  // INCOMPLETE vs its title — kept deliberately (2026-07-12 review call): the
  // title states the INTENDED functionality, that tools route properly to a
  // tmux teammate. A tmux teammate is a session teammate (own session, own
  // hooks), and this test does not yet simulate that second session, so no
  // tool is ever routed TO the teammate. What IS pinned today: the teammate
  // appears, and the lead's Bash + PermissionRequest stay on the LEAD (no
  // misrouting). Closing the gap needs the session-teammate simulation plus a
  // product decision on how that session maps onto the teammate character —
  // see the e2e review notes ("Findings for Florin").
  test('internal terminal lead with tmux teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    const teamName = uniqueTeamName('hooks-on-internal-tmux');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      withInlineTeammateSession(claudeScenario('internal tmux teammate routing hooks on'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        // Lead's Agent tool_use with run_in_background — the lead overlay shows
        // "Subtask: Delegate research" as its activity (team gate suppresses a
        // basic sub-character because the lead has a teamName by now).
        .at(3_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a5-team-spawn', 'Agent', {
            description: 'Delegate research',
            run_in_background: true,
          }),
        )
        .at(6_000)
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(6_500)
        .emitHook(preToolUseAgent('{{sessionId}}', 'Delegate research') as Record<string, unknown>)
        .at(7_000)
        .emitHook(subagentStart('{{sessionId}}', TEAMMATE_ROLE) as Record<string, unknown>)
        .at(10_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .at(13_000)
        .emitHook(permissionRequest('{{sessionId}}') as Record<string, unknown>)
        .holdOpenFor(17_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    await expectLeadActivity(panelFrame, 'Subtask: Delegate research');
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);
    await expectLeadActivity(panelFrame, 'Running: npm test');
    await expectLeadActivity(panelFrame, 'Needs approval');
  });

  test('external session lead with inline teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
    });

    const teamName = uniqueTeamName('hooks-on-external-inline');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    const sessionId = 'hooks-on-external-inline-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: withInlineTeammateSession(
        claudeScenario('external inline teammate routing hooks on'),
      )
        .at(200)
        .emitHook(
          sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
        .at(7_000)
        .emitHook(preToolUseAgent(sessionId, 'Delegate research') as Record<string, unknown>)
        .at(7_500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(10_500)
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(11_000)
        .emitHook(subagentStart(sessionId, TEAMMATE_ROLE) as Record<string, unknown>)
        .at(14_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a9-lead-bash', 'Bash', { command: 'npm test' }),
        )
        .at(17_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a9-teammate-search', 'WebSearch', {
            query: 'pixel agents',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .holdOpenFor(21_000)
        .build(),
    });

    // SessionStart alone (t+0.2s) leaves the session pending. Settle-based
    // check (the scenario can't sequence delivery like sendHookEvent did);
    // PreToolUse only lands at t+7s, leaving wide margin even with the
    // external-monitor terminal opening (~3s) inside the spawn call above.
    await frame.waitForTimeout(1_500);
    await expectOverlayCount(frame, 0);

    await expectOverlayCount(frame, 1);
    await expectOverlayVisibleWithTexts(frame, ['LEAD']);
    await expectOverlayCount(frame, 2);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);
    await expectLeadActivity(frame, 'Running: npm test');
    await expectTeammateActivity(frame, 'Searching the web');
  });

  // Same scope note as the internal tmux test above: the title states the
  // intended functionality; teammate-side routing is not yet simulated.
  test('external session lead with tmux teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
    });

    const teamName = uniqueTeamName('hooks-on-external-tmux');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    const sessionId = 'hooks-on-external-tmux-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: withInlineTeammateSession(claudeScenario('external tmux teammate routing hooks on'))
        .at(200)
        .emitHook(
          sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
        .at(700)
        .emitHook(preToolUseAgent(sessionId, 'Delegate research') as Record<string, unknown>)
        .at(1_200)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a11-team-spawn', 'Agent', {
            description: 'Delegate research',
            run_in_background: true,
          }),
        )
        .at(7_500)
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(8_000)
        .emitHook(subagentStart(sessionId, TEAMMATE_ROLE) as Record<string, unknown>)
        .at(11_000)
        .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>)
        .at(14_000)
        .emitHook(permissionRequest(sessionId) as Record<string, unknown>)
        .holdOpenFor(18_000)
        .build(),
    });

    await expectOverlayCount(frame, 1);
    await expectOverlayVisibleWithTexts(frame, ['LEAD']);
    await expectLeadActivity(frame, 'Subtask: Delegate research');
    await expectOverlayCount(frame, 2);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);
    await expectLeadActivity(frame, 'Running: npm test');
    await expectLeadActivity(frame, 'Needs approval');
  });
});
