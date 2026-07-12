#!/usr/bin/env node
// Cross-platform `tail -n +1 -F` used by the e2e external-session monitor
// terminal (Windows CI has no tail). Follows the external-narration log from
// the beginning, surviving the file not existing yet and truncation. Runs
// until its terminal is closed (VS Code teardown kills the shell tree).
'use strict';

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: tail-follow.cjs <file>\n');
  process.exit(2);
}

const MAGENTA = '\u001b[35m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
process.stdout.write(
  `${MAGENTA}══ external sessions monitor ══${RESET}\n` +
    `${DIM}streams narration from mock claude processes that Pixel Agents adopts\n` +
    `(external sessions have no terminal of their own)${RESET}\n\n`,
);

let position = 0;
setInterval(() => {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return; // not created yet
  }
  if (stat.size < position) position = 0; // truncated — start over
  if (stat.size > position) {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - position);
    fs.readSync(fd, buffer, 0, buffer.length, position);
    fs.closeSync(fd);
    position = stat.size;
    process.stdout.write(buffer.toString('utf8'));
  }
}, 250);
