import { SessionActivityAggregator } from '../../../integrations/openclaw/sessionActivity';
import { expect, test } from '../../fixtures/standalone';
import { expectOverlayCount, expectOverlayVisible, getOverlayByText } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

test.describe('Standalone / OpenClaw', () => {
  test('merges ordinary sessions into one named character with winning activity and separate children @area:standalone', async ({
    page,
    standalone,
  }, testInfo) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    // Standalone exception: real authenticated HTTP → runtime → WebSocket → UI.
    // SDK hook-to-identity mapping is covered separately by relay fixtures.
    const relay = new SessionActivityAggregator(async (event) => {
      const response = await fetch(`${standalone.hostUrl}/api/hooks/openclaw`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${standalone.hookServerConfig.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
      });
      expect(response.ok).toBe(true);
    });
    const send = (session_id: string, event: string, extra = {}) =>
      relay.accept({ session_id, event, ...extra });
    const start = (session: string, actor = 'main-character', name = 'Avery') =>
      send(session, 'session_start', {
        actor_id: actor,
        display_name: name,
        cwd: standalone.workspaceDir,
      });

    await start('research-chat');
    await send('research-chat', 'tool_start', { tool_id: 'read', tool_name: 'web_fetch' });
    await expectOverlayVisible(page, 'Researching the web');
    await start('tool-chat');
    await send('tool-chat', 'tool_start', { tool_id: 'run', tool_name: 'exec' });
    await expectOverlayVisible(page, 'Running a command');
    await start('generation-chat');
    await expectOverlayCount(page, 1);
    await expect(getOverlayByText(page, 'Avery')).toContainText('Working');
    await start('idle-chat');
    await send('idle-chat', 'turn_end');
    await expect(getOverlayByText(page, 'Avery')).toContainText('Working');

    await start('other-agent', 'builder-character', 'Blake');
    await send('other-agent', 'tool_start', { tool_id: 'browse', tool_name: 'web_fetch' });
    await start('child-session', 'child-character', 'Avery · subtask');
    await expectOverlayCount(page, 3);
    await expectOverlayVisible(page, 'Avery · subtask');
    await expect(getOverlayByText(page, 'Blake')).toContainText('Researching the web');
    await page.screenshot({ path: testInfo.outputPath('openclaw-office.png') });

    await send('child-session', 'session_end');
    await send('other-agent', 'session_end');
    await expectOverlayCount(page, 1);
    await send('generation-chat', 'turn_end');
    await expectOverlayVisible(page, 'Running a command');
    await send('tool-chat', 'turn_end');
    await expectOverlayVisible(page, 'Researching the web');
    await send('research-chat', 'turn_end');
    await expectOverlayVisible(page, 'Idle');
    await send('idle-chat', 'session_end');
    await send('tool-chat', 'session_end');
    await send('generation-chat', 'session_end');
    await expectOverlayCount(page, 1);
    await send('research-chat', 'session_end');
    await expectOverlayCount(page, 0);
  });

  test('preserves the base spawn-tool character and removes it when the tool finishes @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const post = async (event: Record<string, unknown>) => {
      const response = await fetch(`${standalone.hostUrl}/api/hooks/openclaw`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${standalone.hookServerConfig.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ session_id: 'spawn-parent', ...event }),
      });
      expect(response.ok).toBe(true);
    };
    await post({ event: 'session_start', cwd: standalone.workspaceDir, display_name: 'Avery' });
    await expectOverlayCount(page, 1);
    await post({ event: 'tool_start', tool_id: 'delegation', tool_name: 'sessions_spawn' });
    await expectOverlayCount(page, 2);
    await expectOverlayVisible(page, 'Subtask');
    await post({ event: 'tool_end', tool_id: 'delegation' });
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Working');
    await post({ event: 'session_end' });
    await expectOverlayCount(page, 0);
  });
});
