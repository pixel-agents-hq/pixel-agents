import type { Frame } from '@playwright/test';

import { test } from '../../../fixtures/pixel-agents';
import {
  permissionRequest,
  preToolUseAgent,
  preToolUseBash,
  sendHookEvent,
  sessionStartStartup,
  subagentStart,
  waitForHookServer,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { uniqueTeamName } from '../../../helpers/lifecycle';
import {
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisibleWithTexts,
} from '../../../helpers/office';
import {
  appendAssistantToolUse,
  appendTeamMetadata,
  createClaudeTranscript,
  createTeammateTranscript,
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

test.describe('Hooks ON / teams', () => {
  test('internal terminal lead with inline teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const serverConfig = await waitForHookServer(tmpHome);

    const teamName = uniqueTeamName('hooks-on-internal-inline');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    appendTeamMetadata(spawned.jsonlFile, teamName);
    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);

    const teammateTranscript = createTeammateTranscript(
      spawned.projectDir,
      spawned.sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, preToolUseAgent(spawned.sessionId, 'Delegate research'));
    await sendHookEvent(serverConfig, subagentStart(spawned.sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);

    appendAssistantToolUse(spawned.jsonlFile, 'toolu-a3-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(panelFrame, 'Running: npm test');

    appendAssistantToolUse(teammateTranscript, 'toolu-a3-teammate-search', 'WebSearch', {
      query: 'pixel agents',
    });
    await expectTeammateActivity(panelFrame, 'Searching the web');
  });

  test('internal terminal lead with tmux teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const serverConfig = await waitForHookServer(tmpHome);

    const teamName = uniqueTeamName('hooks-on-internal-tmux');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);
    appendTeamMetadata(spawned.jsonlFile, teamName);
    await expectOverlayVisibleWithTexts(panelFrame, ['LEAD']);

    appendAssistantToolUse(spawned.jsonlFile, 'toolu-a5-team-spawn', 'Agent', {
      description: 'Delegate research',
      run_in_background: true,
    });
    await expectLeadActivity(panelFrame, 'Subtask: Delegate research');

    createTeammateTranscript(
      spawned.projectDir,
      spawned.sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, preToolUseAgent(spawned.sessionId, 'Delegate research'));
    await sendHookEvent(serverConfig, subagentStart(spawned.sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisibleWithTexts(panelFrame, [TEAMMATE_ROLE]);

    await sendHookEvent(serverConfig, preToolUseBash(spawned.sessionId, 'npm test'));
    await expectLeadActivity(panelFrame, 'Running: npm test');

    await sendHookEvent(serverConfig, permissionRequest(spawned.sessionId));
    await expectLeadActivity(panelFrame, 'Needs approval');
  });

  test('external session lead with inline teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const serverConfig = await waitForHookServer(tmpHome);
    const sessionId = 'hooks-on-external-inline-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    const teamName = uniqueTeamName('hooks-on-external-inline');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));
    await frame.waitForTimeout(500);
    await expectOverlayCount(frame, 0);

    await sendHookEvent(serverConfig, preToolUseAgent(sessionId, 'Delegate research'));
    await expectOverlayCount(frame, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(frame, ['LEAD']);

    const teammateTranscript = createTeammateTranscript(
      projectDir,
      sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, subagentStart(sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(frame, 2);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);

    appendAssistantToolUse(transcriptPath, 'toolu-a9-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(frame, 'Running: npm test');

    appendAssistantToolUse(teammateTranscript, 'toolu-a9-teammate-search', 'WebSearch', {
      query: 'pixel agents',
    });
    await expectTeammateActivity(frame, 'Searching the web');
  });

  test('external session lead with tmux teammate routes tools to teammate @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const serverConfig = await waitForHookServer(tmpHome);
    const sessionId = 'hooks-on-external-tmux-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    const teamName = uniqueTeamName('hooks-on-external-tmux');
    seedTeamConfig(tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));
    await sendHookEvent(serverConfig, preToolUseAgent(sessionId, 'Delegate research'));
    await expectOverlayCount(frame, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(frame, ['LEAD']);

    appendAssistantToolUse(transcriptPath, 'toolu-a11-team-spawn', 'Agent', {
      description: 'Delegate research',
      run_in_background: true,
    });
    await expectLeadActivity(frame, 'Subtask: Delegate research');

    createTeammateTranscript(
      projectDir,
      sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, subagentStart(sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(frame, 2);
    await expectOverlayVisibleWithTexts(frame, [TEAMMATE_ROLE]);

    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectLeadActivity(frame, 'Running: npm test');

    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectLeadActivity(frame, 'Needs approval');
  });
});
