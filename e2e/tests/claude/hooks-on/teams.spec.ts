import type { Frame } from '@playwright/test';

import { test } from '../../../fixtures/pixel-agents';
import {
  permissionRequest,
  preToolUseAgent,
  preToolUseAgentSpawn,
  preToolUseBash,
  sessionEndExit,
  sessionStartStartup,
  stop,
  subagentStart,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  INLINE_TEAMMATE_ALIAS,
  TMUX_TEAMMATE_ALIAS,
  uniqueTeamName,
  withInlineTeammateSession,
  withTmuxTeammateSession,
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
  expectTeammateSeatedNextToLead,
  selectCharacter,
} from '../../../helpers/office';
import {
  buildAgentSettingRecord,
  buildAssistantToolUseRecord,
  buildAsyncAgentLaunchResultRecord,
  buildBackgroundAgentDoneRecord,
  buildTeamMetadataRecord,
  buildTeammateSpawnResultRecord,
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
// ones. Inline teammates share the lead transcript; tmux teammates have a
// separate session and send hooks with that session's identity.
test.describe('Hooks ON / teams', () => {
  test('internal terminal lead with inline teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    const teamName = uniqueTeamName('hooks-on-internal-inline');
    narrator.step('seeding a team config: a lead plus a web-researcher teammate');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging the run: SubagentStart brings in the teammate, then Bash on the lead, WebSearch on the teammate',
    );
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
    narrator.check('the lead is on screen labelled "LEAD"');
    narrator.step(
      'waiting for SubagentStart + the teammate transcript to spawn the web-researcher',
    );
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);
    narrator.check('two characters now — the web-researcher teammate joined');
    await expectLeadActivity(panelFrame, 'Running: npm test');
    narrator.check('"Running: npm test" on the lead only');
    await expectTeammateActivity(panelFrame, 'Searching the web');
    narrator.check('"Searching the web" on the teammate only — routing is strict');
  });

  test('internal terminal lead with tmux teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    const teamName = uniqueTeamName('hooks-on-internal-tmux');
    narrator.step('seeding a team config: a lead plus a tmux teammate');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging the run: the lead delegates, then a distinct tmux teammate session runs Bash and requests permission',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      withTmuxTeammateSession(claudeScenario('internal tmux teammate routing hooks on'))
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
          session: TMUX_TEAMMATE_ALIAS,
        })
        .at(6_500)
        .emitHook(preToolUseAgent('{{sessionId}}', 'Delegate research') as Record<string, unknown>)
        .at(7_000)
        .emitHook(
          sessionStartStartup(
            '{{sessions.tmux-teammate.sessionId}}',
            '{{sessions.tmux-teammate.cwd}}',
            '{{sessions.tmux-teammate.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(10_000)
        .emitHook(
          preToolUseBash('{{sessions.tmux-teammate.sessionId}}', 'npm test') as Record<
            string,
            unknown
          >,
        )
        .at(13_000)
        .emitHook(
          permissionRequest('{{sessions.tmux-teammate.sessionId}}') as Record<string, unknown>,
        )
        .holdOpenFor(17_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    narrator.check('the lead is on screen labelled "LEAD"');
    narrator.step('waiting for the lead to delegate via a background Agent');
    await expectLeadActivity(panelFrame, 'Subtask: Delegate research');
    narrator.check('"Subtask: Delegate research" on the lead — the delegation');
    narrator.step('waiting for the distinct tmux session to be adopted as the teammate');
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);
    narrator.check('the teammate appears — two characters');
    await expectTeammateActivity(panelFrame, 'Running: npm test');
    narrator.check('"Running: npm test" is routed to the tmux teammate, not the lead');
    await expectTeammateActivity(panelFrame, 'Needs approval');
    narrator.check('"Needs approval" is routed to the tmux teammate, not the lead');
  });

  test('new-harness background agent becomes a named teammate character @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    // Newer harnesses (Claude 5) run every Agent spawn in the background as an
    // implicit-team teammate: the tool_input has NO run_in_background flag, the
    // tool_result resolves in seconds with `agent_id: <name>@<team>`, and the
    // agent runs as its OWN top-level session whose records carry teamName/
    // agentName tags. The lead's records carry no team tags at all.
    const role = 'broadcast-researcher';
    const teamName = uniqueTeamName('session-nh');
    const teammateAlias = 'nh-teammate';
    const teammateSessionId = 'aaaaaaaa-1111-4111-8111-e2e000000001';

    narrator.step('seeding the implicit team config the harness writes on spawn');
    seedTeamConfig(tmpHome, teamName, ['team-lead', role]);
    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging the run: unflagged Agent spawn, quick spawn result, teammate as its own top-level tagged session',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('new-harness background agent teammate')
        .defineSession(teammateAlias, teammateSessionId)
        .at(3_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-nh-spawn', 'Agent', {
            name: role,
            description: 'Research broadcast safety',
            subagent_type: 'general-purpose',
          }),
        )
        .at(3_200)
        .emitHook(
          preToolUseAgentSpawn('{{sessionId}}', 'Research broadcast safety', role) as Record<
            string,
            unknown
          >,
        )
        .at(6_000)
        .appendJsonl(buildTeammateSpawnResultRecord('toolu-nh-spawn', role, teamName))
        .at(6_200)
        .appendJsonl(buildAgentSettingRecord(), { session: teammateAlias })
        .at(6_400)
        .appendJsonl(buildTeamMetadataRecord(teamName, role), { session: teammateAlias })
        .at(7_000)
        .emitHook(
          sessionStartStartup(
            `{{sessions.${teammateAlias}.sessionId}}`,
            `{{sessions.${teammateAlias}.cwd}}`,
            `{{sessions.${teammateAlias}.transcriptPath}}`,
          ) as Record<string, unknown>,
        )
        .at(10_000)
        .emitHook(
          preToolUseBash(`{{sessions.${teammateAlias}.sessionId}}`, 'npm test') as Record<
            string,
            unknown
          >,
        )
        .at(17_000)
        .emitHook(
          sessionEndExit(`{{sessions.${teammateAlias}.sessionId}}`) as Record<string, unknown>,
        )
        .holdOpenFor(21_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for the spawn result to mark the internal agent as team lead');
    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    narrator.check(
      'the lead is marked "LEAD" purely from the spawn result — its records have no team tags',
    );
    narrator.step('waiting for the tagged top-level session to appear as a named teammate');
    await expectOverlayVisibleWithTexts(panelFrame, [role]);
    await expectOverlayCount(panelFrame, 2);
    narrator.check(`the ${role} teammate joined — two characters, no ghost Subtask left behind`);
    await expectTeammateSeatedNextToLead(panelFrame, role);
    narrator.check('the teammate took the free seat closest to the lead');
    narrator.step("waiting for the teammate's own-session hooks to route to it");
    await expectOverlayVisibleWithTexts(panelFrame, [role, 'Running: npm test']);
    await expectNoOverlayWithTexts(panelFrame, ['LEAD', 'Running: npm test']);
    narrator.check('"Running: npm test" lands on the teammate only — its own session routes to it');
    narrator.step("waiting for the teammate's SessionEnd to despawn it");
    await expectOverlayCount(panelFrame, 1);
    narrator.check('the teammate despawned on its own SessionEnd — the lead remains');
  });

  test('unnamed background spawn stays a sub-agent with live activity and survives Stop @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    // Unnamed Agent spawns (same CLI, no `name` in the input) take the async
    // path: "Async agent launched successfully", a transcript + sidecar under
    // <sessionId>/subagents/, completion via queue-operation, and no team
    // anywhere. Name is the classifier: unnamed = Sub-agent, so the Subtask
    // sub-character stays and its own transcript animates it (shadow watch ->
    // subagentToolStart). The Stop hook must not kill it; the completion must.
    const spawnToolId = 'toolu-bg-spawn';

    narrator.step(
      'arranging the run: unnamed async spawn with a sidecar, Stop mid-run, then completion',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('unnamed background spawn stays a sub-agent')
        .defineSession('bg-agent', 'agent-bg1', {
          transcriptPathTemplate: '{{projectDir}}/{{sessionId}}/subagents/agent-bg1.jsonl',
          sidecarPathTemplate: '{{projectDir}}/{{sessionId}}/subagents/agent-bg1.meta.json',
          sidecarJson: {
            agentType: 'general-purpose',
            description: 'Say hello',
            toolUseId: spawnToolId,
          },
        })
        .at(3_000)
        .appendJsonl(
          buildAssistantToolUseRecord(spawnToolId, 'Agent', {
            description: 'Say hello',
            subagent_type: 'general-purpose',
          }),
        )
        .at(3_400)
        .appendJsonl(buildAsyncAgentLaunchResultRecord(spawnToolId))
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-bg-search', 'WebSearch', { query: 'greetings' }),
          { session: 'bg-agent' },
        )
        .at(7_000)
        .emitHook(stop('{{sessionId}}') as Record<string, unknown>)
        .at(14_000)
        .appendJsonl(buildBackgroundAgentDoneRecord(spawnToolId))
        .holdOpenFor(18_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for the Subtask sub-character to spawn');
    await expectOverlayVisibleWithTexts(panelFrame, ['Say hello']);
    await expectOverlayCount(panelFrame, 2);
    narrator.check('the Subtask sub-character joined — unnamed spawns stay sub-agents');
    narrator.step('selecting the sub-agent to reveal its live activity');
    await selectCharacter(panelFrame, -1);
    await expectOverlayVisibleWithTexts(panelFrame, ['Searching the web']);
    narrator.check('"Searching the web" on the selected sub-agent — its own transcript drives it');
    narrator.step('Stop fires on the lead mid-run — the sub-character must survive');
    await panelFrame.waitForTimeout(2_000);
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisibleWithTexts(panelFrame, ['Say hello']);
    narrator.check('still two characters after Stop — the sub survives in place');
    narrator.step('waiting for the completion queue-operation to despawn it');
    await expectOverlayCount(panelFrame, 1);
    narrator.check('the sub-agent despawned on completion — the lead remains');
  });

  test('named background spawn becomes a teammate and badges the spawner LEAD @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    // Same async flow, but the sidecar carries a `name` — and name is the
    // classifier: named = Teammate. The spawn becomes a seated character named
    // from the sidecar name (NOT the description), and the spawner gets the
    // derived-team LEAD badge with no CLI team registry anywhere.
    const spawnToolId = 'toolu-bg-named';

    narrator.step('arranging the run: NAMED async spawn with a sidecar, then completion');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('named background spawn becomes a teammate')
        .defineSession('bg-agent', 'agent-bg2', {
          transcriptPathTemplate: '{{projectDir}}/{{sessionId}}/subagents/agent-bg2.jsonl',
          sidecarPathTemplate: '{{projectDir}}/{{sessionId}}/subagents/agent-bg2.meta.json',
          sidecarJson: {
            agentType: 'general-purpose',
            description: 'Write a haiku about refactoring',
            toolUseId: spawnToolId,
            name: 'ghost-writer',
          },
        })
        .at(3_000)
        .appendJsonl(
          buildAssistantToolUseRecord(spawnToolId, 'Agent', {
            description: 'Write a haiku about refactoring',
            subagent_type: 'general-purpose',
            name: 'ghost-writer',
          }),
        )
        .at(3_400)
        .appendJsonl(buildAsyncAgentLaunchResultRecord(spawnToolId))
        .at(5_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-bg-write', 'WebSearch', { query: 'haiku forms' }),
          { session: 'bg-agent' },
        )
        .at(12_000)
        .appendJsonl(buildBackgroundAgentDoneRecord(spawnToolId))
        .holdOpenFor(16_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for the named spawn to join as a teammate');
    await expectOverlayVisibleWithTexts(panelFrame, ['ghost-writer']);
    await expectOverlayCount(panelFrame, 2);
    narrator.check('"ghost-writer" joined — named from the sidecar, not the description');
    narrator.step('checking the spawner got the derived-team LEAD badge');
    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);
    narrator.check('the spawner is badged LEAD — spawning a named agent makes a team');
    narrator.step("waiting for the teammate's own transcript to animate it");
    await expectOverlayVisibleWithTexts(panelFrame, ['ghost-writer', 'Searching the web']);
    narrator.check('"Searching the web" on the teammate — its own transcript drives it');
    narrator.step('waiting for the completion queue-operation to despawn it');
    await expectOverlayCount(panelFrame, 1);
    narrator.check('the teammate despawned on completion — the LEAD remains');
  });

  test('external session lead with inline teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external hooks-only session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    const teamName = uniqueTeamName('hooks-on-external-inline');
    narrator.step('seeding a team config: a lead plus a web-researcher teammate');
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

    // Workspace JSONL polling remains authoritative while hooks are enabled, so
    // this session may be adopted before the delayed t+7s PreToolUse confirms it.
    narrator.step('waiting for JSONL discovery or PreToolUse to adopt the external lead');
    await expectOverlayCount(frame, 1);
    await expectOverlayVisibleWithTexts(frame, ['LEAD']);
    narrator.check('the lead is adopted and labelled "LEAD" — count 1');
    narrator.step('waiting for team metadata + SubagentStart to bring in the teammate');
    await expectOverlayCount(frame, 2);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);
    narrator.check('the web-researcher teammate joined — count 2');
    await expectLeadActivity(frame, 'Running: npm test');
    narrator.check('"Running: npm test" on the lead only');
    await expectTeammateActivity(frame, 'Searching the web');
    narrator.check('"Searching the web" on the teammate only — routing is strict');
  });

  test('external session lead with tmux teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    narrator.step('enabling Watch All Sessions so the external hooks-only session is adopted');
    await setSettings(frame, {
      watchAllSessions: true,
    });

    const teamName = uniqueTeamName('hooks-on-external-tmux');
    narrator.step('seeding a team config: a lead plus a tmux teammate');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    await waitForClaudeHookSetup(tmpHome);
    const sessionId = 'hooks-on-external-tmux-session';

    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: withTmuxTeammateSession(claudeScenario('external tmux teammate routing hooks on'))
        .at(200)
        .emitHook(
          sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(600)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-a11-team-spawn', 'Agent', {
            description: 'Delegate research',
            run_in_background: true,
          }),
        )
        .at(700)
        .emitHook(preToolUseAgent(sessionId, 'Delegate research') as Record<string, unknown>)
        .at(1_200)
        .appendJsonl(buildTeamMetadataRecord(teamName, TEAMMATE_ROLE), {
          session: TMUX_TEAMMATE_ALIAS,
        })
        .at(1_500)
        .emitHook(
          sessionStartStartup(
            '{{sessions.tmux-teammate.sessionId}}',
            '{{sessions.tmux-teammate.cwd}}',
            '{{sessions.tmux-teammate.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(2_000)
        .emitHook(
          preToolUseBash('{{sessions.tmux-teammate.sessionId}}', 'npm test') as Record<
            string,
            unknown
          >,
        )
        .at(4_000)
        .emitHook(
          permissionRequest('{{sessions.tmux-teammate.sessionId}}') as Record<string, unknown>,
        )
        .holdOpenFor(18_000)
        .build(),
    });

    narrator.step('waiting for the external lead to be adopted via hooks');
    await expectOverlayCount(frame, 1);
    await expectOverlayVisibleWithTexts(frame, ['LEAD']);
    narrator.check('the lead is adopted and labelled "LEAD" — count 1');
    narrator.step('waiting for the lead to delegate via a background Agent');
    await expectLeadActivity(frame, 'Subtask: Delegate research');
    narrator.check('"Subtask: Delegate research" on the lead — the delegation');
    narrator.step('waiting for the distinct tmux session to be adopted as the teammate');
    await expectOverlayCount(frame, 2);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);
    narrator.check('the teammate appears — count 2');
    await expectTeammateActivity(frame, 'Running: npm test');
    narrator.check('"Running: npm test" is routed to the tmux teammate, not the lead');
    await expectTeammateActivity(frame, 'Needs approval');
    narrator.check('"Needs approval" is routed to the tmux teammate, not the lead');
  });
});
