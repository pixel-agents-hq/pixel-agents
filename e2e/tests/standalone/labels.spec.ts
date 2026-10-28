import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { setSettings } from '../../helpers/webview';

test('global sessions show their real folder name instead of the encoded suffix @area:standalone', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { watchAllSessions: true, alwaysShowLabels: true });

  const cwd = path.join(standalone.tmpHome, 'mobile_client_new');
  const projectDir = path.join(
    standalone.tmpHome,
    '.claude',
    'projects',
    '-Users-test-mobile-client-new',
  );
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'session.jsonl'),
    JSON.stringify({ type: 'user', cwd, text: 'x'.repeat(3100) }) + '\n',
  );

  const overlay = page.getByTestId('agent-overlay');
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toContainText('mobile_client_new');
});
