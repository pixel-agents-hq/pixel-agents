import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  normalizePackMetadata,
  parsePackJsonOutput,
  validatePackageFiles,
} from './npm-package-contract.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const METADATA_FILE = 'package-metadata.json';
const START_TIMEOUT_MS = 20_000;

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseArgs(argv) {
  let outputDir = null;
  let skipBuild = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--output-dir') {
      outputDir = argv[index + 1];
      if (!outputDir) throw new Error('--output-dir requires a path');
      index++;
    } else if (argv[index] === '--skip-build') {
      skipBuild = true;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return { outputDir, skipBuild };
}

async function execNpm(args, options = {}) {
  return await execFileAsync(npmCommand(), args, {
    cwd: REPO_ROOT,
    env: { ...process.env, HUSKY: '0' },
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate an npm smoke-test port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitFor(check, description) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function verifyInstalledTarball(tarballPath) {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-npm-smoke-'));
  const smokeHome = path.join(smokeRoot, 'home');
  const smokeProject = path.join(smokeRoot, 'project');
  fs.mkdirSync(smokeHome, { recursive: true });
  fs.mkdirSync(smokeProject, { recursive: true });
  fs.writeFileSync(
    path.join(smokeProject, 'package.json'),
    JSON.stringify({ name: 'pixel-agents-package-smoke', private: true }, null, 2),
  );

  let child = null;
  let output = '';
  try {
    await execNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], {
      cwd: smokeProject,
    });

    const installedRoot = path.join(smokeProject, 'node_modules', 'pixel-agents');
    const installedManifest = JSON.parse(
      fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf-8'),
    );
    if (installedManifest.bin?.['pixel-agents'] !== './dist/cli.js') {
      throw new Error('Installed package has an unexpected pixel-agents bin entry');
    }

    const installedCli = path.join(installedRoot, 'dist', 'cli.js');
    const firstLine = fs.readFileSync(installedCli, 'utf-8').split('\n', 1)[0];
    if (firstLine !== '#!/usr/bin/env node') {
      throw new Error(`Installed CLI is missing its Node shebang: ${firstLine}`);
    }

    const installedBin = path.join(
      smokeProject,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'pixel-agents.cmd' : 'pixel-agents',
    );
    const help = await execFileAsync(installedBin, ['--help'], {
      cwd: smokeProject,
      env: { ...process.env, HOME: smokeHome, USERPROFILE: smokeHome },
      shell: process.platform === 'win32',
    });
    if (!help.stdout.includes('Usage: pixel-agents')) {
      throw new Error('Installed pixel-agents bin did not print CLI help');
    }

    const port = await getFreePort();
    child = spawn(
      process.execPath,
      [installedCli, '--port', port.toString(), '--host', '127.0.0.1'],
      {
        cwd: smokeProject,
        env: { ...process.env, HOME: smokeHome, USERPROFILE: smokeHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));

    const baseUrl = `http://127.0.0.1:${port.toString()}`;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`CLI exited early:\n${output}`);
      try {
        return (await fetch(`${baseUrl}/api/health`)).ok;
      } catch {
        return false;
      }
    }, 'installed CLI health endpoint');

    const htmlResponse = await fetch(`${baseUrl}/`);
    const html = await htmlResponse.text();
    if (!htmlResponse.ok || !html.includes('<div id="root"></div>')) {
      throw new Error('Installed CLI did not serve the standalone SPA index');
    }
    const scriptSource = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
    if (!scriptSource)
      throw new Error('Standalone SPA index did not reference its JavaScript bundle');
    const scriptResponse = await fetch(new URL(scriptSource, `${baseUrl}/`));
    if (!scriptResponse.ok || (await scriptResponse.text()).length === 0) {
      throw new Error('Installed CLI did not serve the standalone SPA JavaScript bundle');
    }

    await waitFor(
      () => /Assets loaded: \d+ characters, \d+ pets, \d+ furniture items/.test(output),
      'asset summary',
    );
    const counts = /Assets loaded: (\d+) characters, (\d+) pets, (\d+) furniture items/.exec(
      output,
    );
    if (!counts || counts.slice(1).some((value) => Number(value) <= 0)) {
      throw new Error(`Installed package did not load non-empty bundled assets:\n${output}`);
    }

    const installedHook = path.join(smokeHome, '.pixel-agents', 'hooks', 'claude-hook.js');
    const settingsPath = path.join(smokeHome, '.claude', 'settings.json');
    await waitFor(
      () => fs.existsSync(installedHook) && fs.existsSync(settingsPath),
      'default Hook ON installation',
    );
    if (process.platform !== 'win32' && (fs.statSync(installedHook).mode & 0o100) === 0) {
      throw new Error('Installed Claude hook script is not owner-executable');
    }
    const settingsText = fs.readFileSync(settingsPath, 'utf-8');
    const normalizedSettings = settingsText.replaceAll('\\\\', '/');
    const normalizedHookPath = installedHook.replaceAll(path.sep, '/');
    if (!normalizedSettings.includes(normalizedHookPath)) {
      throw new Error('Claude hook settings do not reference the installed hook script');
    }

    return { assetCounts: counts.slice(1).map(Number), port };
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ownsOutputDir = args.outputDir === null;
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-npm-pack-'));

  if (!ownsOutputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    const existing = fs.readdirSync(outputDir);
    if (existing.length > 0) {
      throw new Error(`--output-dir must be empty: ${outputDir}`);
    }
  }

  try {
    const packArgs = ['pack', '--json', '--pack-destination', outputDir];
    if (args.skipBuild) packArgs.splice(1, 0, '--ignore-scripts');
    const { stdout } = await execNpm(packArgs);
    const parsed = parsePackJsonOutput(stdout);
    const packed = normalizePackMetadata(parsed);
    validatePackageFiles(packed.files);

    const tarballPath = path.join(outputDir, packed.filename);
    if (!fs.existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`);
    const smoke = await verifyInstalledTarball(tarballPath);
    const metadata = { ...packed, tarballPath, smoke };

    if (!ownsOutputDir) {
      fs.writeFileSync(path.join(outputDir, METADATA_FILE), JSON.stringify(metadata, null, 2));
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '## npm artifact',
          '',
          '| Package | Tarball | Files | Packed | Unpacked | Integrity |',
          '| --- | --- | ---: | ---: | ---: | --- |',
          `| ${packed.id} | ${packed.filename} | ${packed.entryCount} | ${packed.size} bytes | ${packed.unpackedSize} bytes | \`${packed.integrity}\` |`,
          '',
          `Smoke: ${smoke.assetCounts.join('/')} character/pet/furniture assets; HTTP/SPA/Hook ON passed.`,
          '',
        ].join('\n'),
      );
    }
    console.log(
      JSON.stringify(
        {
          id: packed.id,
          filename: packed.filename,
          integrity: packed.integrity,
          size: packed.size,
          unpackedSize: packed.unpackedSize,
          entryCount: packed.entryCount,
          smoke,
        },
        null,
        2,
      ),
    );
  } finally {
    if (ownsOutputDir) fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
