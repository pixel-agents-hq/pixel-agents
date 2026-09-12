import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runTests } from '@vscode/test-electron';

const execFileAsync = promisify(execFile);

const REQUIRED_FILES = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/cli.js',
  'extension/dist/hooks/claude-hook.js',
  'extension/dist/hooks/codex-hook.js',
  'extension/dist/webview/index.html',
];
const FORBIDDEN_PREFIXES = [
  'extension/adapters/',
  'extension/core/',
  'extension/docs/',
  'extension/e2e/',
  'extension/reports/',
  'extension/scripts/',
  'extension/server/',
  'extension/test-results/',
  'extension/webview-ui/',
  // The extension bundle is self-contained. Any dependency tree here is a
  // packaging regression, not a runtime requirement.
  'extension/node_modules/',
];

function parseArgs(argv) {
  if (argv.length !== 1)
    throw new Error('Usage: node scripts/verify-vsix-package.mjs <extension.vsix>');
  return path.resolve(argv[0]);
}

function validateInventory(paths) {
  const problems = [];
  const pathSet = new Set(paths);
  for (const required of REQUIRED_FILES) {
    if (!pathSet.has(required)) problems.push(`missing required VSIX file: ${required}`);
  }
  for (const file of paths) {
    const forbidden = FORBIDDEN_PREFIXES.find((prefix) => file.startsWith(prefix));
    if (forbidden) problems.push(`forbidden VSIX path: ${file}`);
    if (file.endsWith('.map')) problems.push(`source map must not ship in VSIX: ${file}`);
  }
  if (problems.length > 0) throw new Error(`Invalid VSIX contents:\n- ${problems.join('\n- ')}`);
}

function writeExtensionSmokeRunner(filePath, extensionId) {
  fs.writeFileSync(
    filePath,
    `const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

exports.run = async () => {
  const extension = vscode.extensions.getExtension(${JSON.stringify(extensionId)});
  if (!extension) throw new Error('Packaged extension was not discoverable: ${extensionId}');
  await extension.activate();
  if (!extension.isActive) throw new Error('Packaged extension did not activate');
  await vscode.commands.executeCommand('pixel-agents.showPanel');

  const registryDir = path.join(os.homedir(), '.pixel-agents', 'servers');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (fs.readdirSync(registryDir).some((file) => file.endsWith('.json'))) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Packaged extension did not start its embedded server');
};
`,
  );
}

async function verifyExtensionHost(extensionRoot, smokeRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  if (typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string') {
    throw new Error('Packaged extension manifest is missing publisher/name');
  }
  const home = path.join(smokeRoot, 'home');
  const runner = path.join(smokeRoot, 'extension-smoke.cjs');
  const shortTmpRoot = process.platform !== 'win32' && fs.existsSync('/tmp') ? '/tmp' : smokeRoot;
  const userDataDir = fs.mkdtempSync(path.join(shortTmpRoot, 'pa-vsix-'));
  fs.mkdirSync(home, { recursive: true });
  writeExtensionSmokeRunner(runner, `${manifest.publisher}.${manifest.name}`);
  try {
    await runTests({
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: runner,
      extensionTestsEnv: { ...process.env, HOME: home, USERPROFILE: home },
      launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        '--user-data-dir',
        userDataDir,
        ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : []),
      ],
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  const vsixPath = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(vsixPath)) throw new Error(`VSIX does not exist: ${vsixPath}`);
  const { stdout } = await execFileAsync('unzip', ['-Z1', vsixPath], {
    maxBuffer: 20 * 1024 * 1024,
  });
  const inventory = stdout.split(/\r?\n/).filter(Boolean);
  validateInventory(inventory);

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-vsix-smoke-'));
  try {
    await execFileAsync('unzip', ['-q', vsixPath, '-d', smokeRoot]);
    await verifyExtensionHost(path.join(smokeRoot, 'extension'), smokeRoot);
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
  console.log(`VSIX inventory and extension-host smoke passed: ${path.basename(vsixPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
