import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, vi } from 'vitest';

// Legacy fixtures change HOME between tests. Native os.homedir() ignores HOME
// on Windows, which made those tests read/write the operator's real settings.
// This mock is test-only; suite-specific os mocks can still replace it.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => process.env.HOME || isolatedHome };
});

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const temporaryRoot = path.resolve(os.tmpdir());
const isolatedHome = fs.mkdtempSync(path.join(temporaryRoot, 'pxl-vitest-home-'));

// The default is isolated too, including tests that do not define a HOME
// fixture and subprocesses that use the native (unmocked) os module.
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  const resolvedHome = path.resolve(isolatedHome);
  if (
    path.dirname(resolvedHome) !== temporaryRoot ||
    !path.basename(resolvedHome).startsWith('pxl-vitest-home-')
  ) {
    throw new Error('Refusing to clean a test home outside the temporary directory.');
  }
  fs.rmSync(resolvedHome, { recursive: true, force: true });
});
