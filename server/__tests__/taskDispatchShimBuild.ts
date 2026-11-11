import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Bundle the stdio shim exactly as esbuild.js does (CJS, node18, bundled) into
 * a temp dir, so the shim suites run the real artifact without depending on a
 * prior `npm run compile`.
 */
export async function buildShim(): Promise<{ shimPath: string; cleanup: () => void }> {
  const esbuild = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-shim-'));
  const shimPath = path.join(dir, 'pixel-agents-mcp.js');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'taskDispatch', 'mcpShim.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: shimPath,
    logLevel: 'silent',
  });
  return { shimPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
