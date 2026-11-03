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
