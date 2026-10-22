import { expect, test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../../helpers/mock-claude';
import { expectOverlayVisible } from '../../../helpers/office';
import { buildAssistantToolUseRecord } from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

test('preserves task text across a UTF-8 read boundary @area:lifecycle', async ({
  pixelAgents,
}) => {
  const { frame, window, tmpHome, mockLogFile } = pixelAgents;
  await setSettings(frame, { hooksEnabled: false });
  const description = '整理文档';
  const makeRecord = (padding: number) =>
    buildAssistantToolUseRecord('utf8-task', 'Task', { prompt: 'a'.repeat(padding), description });
  const prefixBytes = Buffer.from(JSON.stringify(makeRecord(0))).indexOf(Buffer.from('整'));
  const record = makeRecord(65535 - prefixBytes);
  expect(Buffer.from(JSON.stringify(record)).indexOf(Buffer.from('整'))).toBe(65535);
  await arrangeNextClaudeInvocation(
    tmpHome,
    claudeScenario('UTF-8 transcript boundary')
      .withoutAutoInit()
      .at(2500)
      .appendJsonl(record)
      .holdOpenFor(12000)
      .build(),
  );
  await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
  await openPixelAgentsPanel(window);
  const panelFrame = await getPixelAgentsFrame(window);
  await expectOverlayVisible(panelFrame, `Subtask: ${description}`, 12000);
});
