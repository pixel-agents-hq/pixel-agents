#!/usr/bin/env node
// Cross-platform `tail -n +1 -F` used by the e2e narration surfaces (Windows CI
// has no tail). Follows one OR MORE narration logs from the beginning, surviving
// files that don't exist yet and truncation. Because it starts at byte 0, a tab
// opened mid-test replays the whole story so far. Runs until its terminal is
// closed (VS Code teardown kills the shell tree).
//
//   node tail-follow.cjs <style> <file> [file...]
//     styles: monitor | external | test | none
//
// - monitor : combined header (yellow accent). The default surface — one tab
//             tailing BOTH the test log and the external log.
// - external: legacy magenta header (external-only framing).
// - test    : legacy yellow header (test-only framing).
// - none    : no header at all — used inside mock-claude tabs, where the runner
//             prints its own banner and the tail just interleaves the narration.
'use strict';

const fs = require('fs');

const style = process.argv[2];
// Everything after the style is a log file to follow. Falsy/empty args are
// skipped so callers can pass an optional second path unconditionally (e.g.
// "${EXTERNAL_LOG:-}") without special-casing when it is unset.
const files = process.argv.slice(3).filter(Boolean);
if (!style || files.length === 0) {
  process.stderr.write('usage: tail-follow.cjs <style> <file> [file...]\n');
  process.exit(2);
}

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

// Header presets. `none` prints nothing (the mock tab's runner owns the banner).
const STYLES = {
  monitor: {
    color: '\u001b[33m', // yellow accent
    title: 'e2e monitor',
    sub:
      'yellow [test] = actions + checks from the Playwright test · ' +
      'magenta [external·tag] = detached mock claude sessions · cosmetic only',
  },
  external: {
    color: '\u001b[35m', // magenta — matches the [external·tag] line prefix
    title: 'external sessions monitor',
    sub:
      'streams narration from mock claude processes that Pixel Agents adopts\n' +
      '(external sessions have no terminal of their own)',
  },
  test: {
    color: '\u001b[33m', // yellow — matches the [test] line prefix
    title: 'test narrator',
    sub:
      'streams the actions this Playwright test performs and the checks it makes\n' +
      '(cosmetic only — assertions run in the test process, not in this terminal)',
  },
};

const preset = STYLES[style];
if (preset) {
  process.stdout.write(
    `${preset.color}══ ${preset.title} ══${RESET}\n` + `${DIM}${preset.sub}${RESET}\n\n`,
  );
}
// style === 'none' (or any unknown style): no header.

// Per-file read positions, indexed alongside `files`.
const positions = new Array(files.length).fill(0);

setInterval(() => {
  // Poll each file in argv order and emit its new bytes; a ≤250 ms interleave
  // skew between logs is fine for a cosmetic narration stream.
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // not created yet
    }
    if (stat.size < positions[i]) positions[i] = 0; // truncated — start over
    if (stat.size > positions[i]) {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(stat.size - positions[i]);
      fs.readSync(fd, buffer, 0, buffer.length, positions[i]);
      fs.closeSync(fd);
      positions[i] = stat.size;
      process.stdout.write(buffer.toString('utf8'));
    }
  }
}, 250);
