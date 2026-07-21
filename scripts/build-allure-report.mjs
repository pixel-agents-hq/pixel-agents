import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsRootDir = path.join(repoRoot, 'allure-results');
const reportDir = path.join(repoRoot, 'allure-report', 'allure');
const reportName = 'Pixel Agents Cross-Platform Test Report';
const metadataFileNames = new Set([
  'categories.json',
  'environment.json',
  'environment.properties',
  'executor.json',
]);
const suiteNames = ['e2e', 'server', 'webview'];

function hasFiles(dir) {
  if (!existsSync(dir)) return false;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFiles(path.join(dir, entry.name))) return true;
  }

  return false;
}

function getSuiteResults() {
  return suiteNames
    .map((suiteName) => ({
      name: suiteName,
      dir: path.join(resultsRootDir, suiteName),
    }))
    .filter(({ dir }) => hasFiles(dir));
}

function copyResults(sourceDir, targetDir) {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);

    if (entry.isDirectory()) {
      copyResults(sourcePath, targetDir);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (metadataFileNames.has(entry.name)) {
      continue;
    }

    const targetPath = path.join(targetDir, entry.name);
    if (existsSync(targetPath)) {
      throw new Error(`Duplicate Allure result file detected: ${entry.name}`);
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function writeGithubMetadata(resultsDir, suites) {
  if (!hasFiles(resultsDir)) return;

  const serverUrl = process.env['GITHUB_SERVER_URL'];
  const repository = process.env['GITHUB_REPOSITORY'];
  const runId = process.env['GITHUB_RUN_ID'];
  const runNumber = process.env['GITHUB_RUN_NUMBER'];
  const workflow = process.env['GITHUB_WORKFLOW'];
  const refName = process.env['GITHUB_REF_NAME'];

  if (serverUrl && repository && runId) {
    writeFileSync(
      path.join(resultsDir, 'executor.json'),
      JSON.stringify(
        {
          name: 'GitHub Actions',
          type: 'github',
          buildName: workflow && runNumber ? `${workflow} #${runNumber}` : workflow,
          buildOrder: runNumber ? Number.parseInt(runNumber, 10) : undefined,
          buildUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
          reportName,
        },
        null,
        2,
      ),
    );
  }

  const environmentLines = [
    `deployment=vercel`,
    `os=${process.platform}`,
    `branch=${refName ?? 'local'}`,
    `suites=${suites.map(({ name }) => name).join(',')}`,
  ];
  writeFileSync(
    path.join(resultsDir, 'environment.properties'),
    `${environmentLines.join('\n')}\n`,
  );
}

function writePlaceholderReport() {
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pixel Agents Linux Test Report Unavailable</title>
    <style>
      :root {
        color-scheme: light;
        font-family: system-ui, sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f6f8;
        color: #17202a;
      }
      main {
        max-width: 36rem;
        padding: 2rem;
        border: 1px solid #d0d7de;
        background: #ffffff;
        box-shadow: 0 12px 40px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin-top: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Linux test report unavailable</h1>
      <p>No Linux Allure results were produced for this run, so there is no hosted report to display.</p>
      <p>Check the workflow logs for skipped or failed Linux uploads from the e2e, server, or webview suites.</p>
    </main>
  </body>
</html>
`,
  );
}

const suites = getSuiteResults();

if (suites.length === 0) {
  writePlaceholderReport();
  process.exit(0);
}

rmSync(reportDir, { recursive: true, force: true });
mkdirSync(path.dirname(reportDir), { recursive: true });

const stagedResultsDir = mkdtempSync(path.join(tmpdir(), 'pixel-agents-allure-'));

for (const suite of suites) {
  copyResults(suite.dir, stagedResultsDir);
}

writeGithubMetadata(stagedResultsDir, suites);

const allureBinary = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'allure.cmd' : 'allure',
);

try {
  const result = spawnSync(
    allureBinary,
    ['generate', stagedResultsDir, '--clean', '-o', reportDir, '--name', reportName],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} finally {
  rmSync(stagedResultsDir, { recursive: true, force: true });
}
