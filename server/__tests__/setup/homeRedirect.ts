// Tests isolate persistence by pointing $HOME at a temp dir. On Windows
// os.homedir() reads USERPROFILE, not HOME, so without this the suite reads and
// writes the developer's real ~/.pixel-agents.
import { createRequire, syncBuiltinESMExports } from 'module';

if (process.platform === 'win32') {
  const os = createRequire(import.meta.url)('os') as typeof import('os');
  const realHomedir = os.homedir;
  os.homedir = () => process.env.HOME || realHomedir();
  syncBuiltinESMExports();
}
