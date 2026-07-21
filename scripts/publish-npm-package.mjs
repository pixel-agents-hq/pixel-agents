import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  getPublicationDecision,
  validateReleaseIdentity,
  validateTarballIntegrity,
} from './npm-package-contract.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!['--metadata', '--ref', '--tag'].includes(option) || !value) {
      throw new Error(`Expected --metadata, --ref, and --tag; received ${argv.join(' ')}`);
    }
    values[option.slice(2)] = value;
  }
  if (!values.metadata || !values.ref || !values.tag) {
    throw new Error('--metadata, --ref, and --tag are all required');
  }
  return values;
}

async function npmView(args) {
  const result = await execFileAsync(npmCommand(), ['view', ...args, '--json'], {
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout.trim());
}

async function getPublishedIntegrity(packageId) {
  try {
    return await npmView([packageId, 'dist.integrity']);
  } catch (error) {
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    if (output.includes('E404')) return null;
    throw error;
  }
}

async function npmPublish(tarballPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(npmCommand(), ['publish', tarballPath], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm publish exited with code ${String(code)}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
  const metadata = JSON.parse(fs.readFileSync(path.resolve(args.metadata), 'utf-8'));
  const latestVersion = await npmView([manifest.name, 'dist-tags.latest']);
  const expectedId = `${manifest.name}@${manifest.version}`;
  const publishedIntegrity = await getPublishedIntegrity(expectedId);

  validateReleaseIdentity({
    manifest,
    releaseTag: args.tag,
    ref: args.ref,
    latestVersion,
    exactVersionExists: publishedIntegrity !== null,
  });

  if (metadata.id !== expectedId) {
    throw new Error(`Packed artifact ${String(metadata.id)} does not match release ${expectedId}`);
  }
  if (typeof metadata.integrity !== 'string' || metadata.integrity.length === 0) {
    throw new Error('Packed artifact metadata is missing integrity');
  }
  const tarballPath = path.resolve(metadata.tarballPath);
  if (!fs.existsSync(tarballPath)) throw new Error(`Packed artifact is missing: ${tarballPath}`);
  validateTarballIntegrity(tarballPath, metadata.integrity);

  const decision = getPublicationDecision(metadata.integrity, publishedIntegrity);
  if (decision === 'skip') {
    console.log(`[npm publish] ${expectedId} already exists with matching integrity; no-op.`);
    return;
  }
  if (decision === 'conflict') {
    throw new Error(
      `${expectedId} already exists with different integrity; refusing to treat it as an idempotent rerun.`,
    );
  }

  await npmPublish(tarballPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
