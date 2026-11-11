import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Every test file starts with $HOME pointing at a fresh temp directory, so nothing a test
 * reads or writes under ~/.pixel-agents or ~/.claude can be the developer's real data.
 * The palette count, for one, lazily reads ~/.pixel-agents/characters.json. Suites that
 * need their own home still redirect it themselves (and restore this one).
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-test-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

/**
 * No test may run the real `claude`: on macOS its login lives in the keychain, not
 * under $HOME, so a stray spawn would start a real, billed session. A stub that fails
 * loudly sits first on PATH; a test that wants mock-claude puts its own bin before it.
 */
const guardBin = path.join(isolatedHome, '.real-claude-guard');
fs.mkdirSync(guardBin, { recursive: true });
const guardScript = path.join(guardBin, 'claude');
fs.writeFileSync(
  guardScript,
  '#!/bin/sh\necho "[test guard] the real claude CLI is blocked in server tests" >&2\nexit 97\n',
  { mode: 0o755 },
);
if (process.platform === 'win32') {
  fs.writeFileSync(
    path.join(guardBin, 'claude.cmd'),
    '@echo [test guard] the real claude CLI is blocked in server tests 1>&2\r\n@exit /b 97\r\n',
  );
}
process.env.PATH = `${guardBin}${path.delimiter}${process.env.PATH ?? ''}`;
