#!/usr/bin/env node
// Run a Node script with its stdout and stderr appended to a size-capped log, so
// a board left running for weeks can't fill the disk. When the log would pass
// MAX_LOG_BYTES it becomes <log>.1 (replacing the previous one) and a fresh log
// starts. Exits with the script's exit code, so the autostart launcher sees crashes.
//
// Usage: node run-logged.mjs <log> <script> [args...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function createRotatingLog(file, maxBytes = MAX_LOG_BYTES) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // no log yet
  }
  let fd = fs.openSync(file, 'a');
  return {
    write(chunk) {
      if (size > 0 && size + chunk.length > maxBytes) {
        fs.closeSync(fd);
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // another process holds the file: keep appending rather than lose output
        }
        fd = fs.openSync(file, 'a');
        size = fs.fstatSync(fd).size;
      }
      fs.writeSync(fd, chunk);
      size += chunk.length;
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

function main([logFile, script, ...args]) {
  if (!logFile || !script) {
    console.error('Usage: node run-logged.mjs <log> <script> [args...]');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
  const log = createRotatingLog(logFile);
  const note = (msg) => log.write(Buffer.from(`[run-logged] ${new Date().toISOString()} ${msg}\n`));
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => log.write(chunk));
  child.stderr.on('data', (chunk) => log.write(chunk));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => {
    note(`failed to start: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code, signal) => {
    note(`exited with code ${code ?? 'none'}${signal ? ` (signal ${signal})` : ''}`);
    log.close();
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
