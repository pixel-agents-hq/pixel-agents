import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type JsonFileWatcher, watchJsonFile, writeJsonAtomic } from '../src/jsonFileWatcher.js';

const POLL_MS = 50;
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchJsonFile', () => {
  let dir: string;
  let file: string;
  let watcher: JsonFileWatcher | null = null;
  const seen: unknown[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-watch-'));
    file = path.join(dir, 'data.json');
    fs.writeFileSync(file, JSON.stringify({ n: 0 }));
    seen.length = 0;
    watcher = watchJsonFile(file, 'test', (value) => seen.push(value), POLL_MS);
  });

  afterEach(() => {
    watcher?.dispose();
    watcher = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports an external change', async () => {
    await tick();
    fs.writeFileSync(file, JSON.stringify({ n: 1 }));
    await vi.waitFor(() => expect(seen).toEqual([{ n: 1 }]), { timeout: 2000 });
  });

  it('does not report our own write, for every watcher of the path', async () => {
    const second: unknown[] = [];
    const other = watchJsonFile(file, 'test', (value) => second.push(value), POLL_MS);
    await tick();
    writeJsonAtomic(file, { n: 1 });
    await tick(POLL_MS * 4);
    other.dispose();
    expect(seen).toEqual([]);
    expect(second).toEqual([]);
  });

  it('a failed write marks nothing, so the next external change is still reported', async () => {
    await tick();
    expect(() => writeJsonAtomic(path.join(file, 'not-a-dir.json'), { n: 1 })).toThrow();
    writeJsonAtomic(path.join(dir, 'elsewhere.json'), { n: 1 });
    await tick();
    fs.writeFileSync(file, JSON.stringify({ n: 2 }));
    await vi.waitFor(() => expect(seen).toEqual([{ n: 2 }]), { timeout: 2000 });
  });

  it('a disposed watcher no longer takes marks', async () => {
    watcher!.dispose();
    watcher = null;
    expect(() => writeJsonAtomic(file, { n: 3 })).not.toThrow();
  });
});
