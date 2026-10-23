import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRotatingLog } from './run-logged.mjs';

const WRAPPER = fileURLToPath(new URL('./run-logged.mjs', import.meta.url));

describe('createRotatingLog', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-runlogged-'));
    file = path.join(dir, 'board.log');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appends to an existing log', () => {
    fs.writeFileSync(file, 'old\n');
    const log = createRotatingLog(file, 1000);
    log.write(Buffer.from('new\n'));
    log.close();
    assert.equal(fs.readFileSync(file, 'utf-8'), 'old\nnew\n');
  });

  it('moves a full log to .1 and starts a fresh one, keeping one backup', () => {
    const log = createRotatingLog(file, 10);
    log.write(Buffer.from('aaaaaaaa\n')); // 9 bytes
    log.write(Buffer.from('bbbbbbbb\n')); // would pass 10: rotate first
    log.write(Buffer.from('cccccccc\n')); // rotate again, replacing .1
    log.close();
    assert.equal(fs.readFileSync(file, 'utf-8'), 'cccccccc\n');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf-8'), 'bbbbbbbb\n');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['board.log', 'board.log.1']);
  });

  it('counts a pre-existing log toward the limit', () => {
    fs.writeFileSync(file, 'x'.repeat(10));
    const log = createRotatingLog(file, 10);
    log.write(Buffer.from('y\n'));
    log.close();
    assert.equal(fs.readFileSync(file, 'utf-8'), 'y\n');
  });
});

describe('run-logged.mjs', () => {
  it('logs the script output and exits with its code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-runlogged-'));
    try {
      const script = path.join(dir, 'child.mjs');
      fs.writeFileSync(
        script,
        'console.log("hello", process.argv[2]); console.error("oops"); process.exit(3);\n',
      );
      const log = path.join(dir, 'out.log');
      const run = spawnSync(process.execPath, [WRAPPER, log, script, 'arg1'], {
        encoding: 'utf-8',
      });
      assert.equal(run.status, 3);
      const text = fs.readFileSync(log, 'utf-8');
      assert.match(text, /hello arg1/);
      assert.match(text, /oops/);
      assert.match(text, /exited with code 3/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
