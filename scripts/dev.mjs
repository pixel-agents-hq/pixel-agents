#!/usr/bin/env node
/**
 * Standalone dev mode: one command rebuilds the CLI and webview on change and
 * restarts the server on every CLI rebuild. If any process exits, or on
 * Ctrl+C, every other one is stopped too.
 *
 *   npm run dev                 # server on port 3100
 *   npm run dev -- --port 4000  # extra arguments go to the CLI
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webviewDir = path.join(root, 'webview-ui');
const DEFAULT_PORT = '3100';
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function findViteBin() {
  const candidates = [
    path.join(webviewDir, 'node_modules', '.bin', 'vite'),
    path.join(root, 'node_modules', '.bin', 'vite'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('vite not found: run `npm install` first.');
  return found;
}

function runOnce(label, command, args, cwd) {
  console.log(`[dev] ${label}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[dev] ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

const viteBin = findViteBin();
const cliArgs = process.argv.slice(2);
if (!cliArgs.some((arg) => arg === '--port' || arg === '-p')) {
  cliArgs.push('--port', DEFAULT_PORT);
}

runOnce('initial build: extension, CLI, hooks', process.execPath, ['esbuild.js'], root);
runOnce('initial build: webview', viteBin, ['build'], webviewDir);

const services = [
  { name: 'esbuild', command: process.execPath, args: ['esbuild.js', '--watch'], cwd: root },
  { name: 'webview', command: viteBin, args: ['build', '--watch'], cwd: webviewDir },
  {
    name: 'server',
    command: process.execPath,
    args: ['--watch', 'dist/cli.js', ...cliArgs],
    cwd: root,
  },
];

const running = [];
let stopping = false;

function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of running) child.kill('SIGTERM');
  setTimeout(() => process.exit(exitCode), 200).unref();
}

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    stdio: 'inherit',
  });
  running.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[dev] ${service.name} exited (${signal ?? code}); stopping everything`);
    stopAll(code ?? 1);
  });
}

for (const signal of STOP_SIGNALS) process.on(signal, () => stopAll(0));
