import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIRECTORY_SUGGESTION_HEAD_BYTES, DIRECTORY_SUGGESTION_LIMIT } from '../src/constants.js';
import { saveUserDirectory } from '../src/directories.js';
import {
  collectDirectorySuggestions,
  type SuggestionProvider,
} from '../src/directorySuggestions.js';

/**
 * Recovering "places you've already worked" out of the coding agent's session
 * transcripts, so the Directory modal can offer them as taps.
 *
 * Everything runs against real files with $HOME redirected to a temp dir, the
 * same isolation directories.test.ts uses — the point of this seam is what it
 * reads off a disk that looks like a used machine.
 */
describe('directorySuggestions', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  /** Stands in for ~/.claude/projects: one subdirectory per session location. */
  let sessionRoot: string;

  const provider: SuggestionProvider = {
    getAllSessionRoots: () => [sessionRoot],
    sessionFilePattern: '*.jsonl',
  };

  beforeEach(() => {
    tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-suggest-test-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    sessionRoot = path.join(tempHome, 'sessions');
    fs.mkdirSync(sessionRoot);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** A real directory on disk, so an existence check passes. */
  function makeDirectory(name: string): string {
    const dirPath = path.join(tempHome, name);
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  }

  /**
   * A session transcript recording `cwd`, in its own session directory — the
   * shape a coding agent leaves behind after running somewhere.
   */
  function seedTranscript(
    sessionDirName: string,
    cwd: string,
    options: { sessionId?: string; lines?: Array<Record<string, unknown>> } = {},
  ): string {
    const sessionDir = path.join(sessionRoot, sessionDirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    const transcript = path.join(sessionDir, `${options.sessionId ?? 'session'}.jsonl`);
    const lines = options.lines ?? [
      { type: 'system', subtype: 'init' },
      { type: 'user', cwd, message: { role: 'user', content: 'hi' } },
    ];
    fs.writeFileSync(transcript, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    return transcript;
  }

  it('recovers the working directory a transcript records', () => {
    const project = makeDirectory('recovered-project');
    seedTranscript('proj-a', project);

    expect(collectDirectorySuggestions(provider, [])).toEqual([project]);
  });

  it('suggests each directory once, however many sessions ran there', () => {
    const project = makeDirectory('busy-project');
    seedTranscript('proj-a', project, { sessionId: 'one' });
    seedTranscript('proj-a', project, { sessionId: 'two' });
    // The same location written with a trailing separator is the same Directory.
    seedTranscript('proj-a-again', `${project}${path.sep}`);

    expect(collectDirectorySuggestions(provider, [])).toEqual([project]);
  });

  it('drops directories that no longer exist', () => {
    const gone = path.join(tempHome, 'deleted-project');
    const alive = makeDirectory('living-project');
    seedTranscript('proj-gone', gone);
    seedTranscript('proj-alive', alive);

    expect(collectDirectorySuggestions(provider, [])).toEqual([alive]);
  });

  it('drops a path that exists but is a file', () => {
    const file = path.join(tempHome, 'notes.txt');
    fs.writeFileSync(file, 'hi', 'utf-8');
    seedTranscript('proj-file', file);

    expect(collectDirectorySuggestions(provider, [])).toEqual([]);
  });

  it('never suggests something already in the union', () => {
    const hostDir = makeDirectory('host-project');
    const userDir = makeDirectory('user-project');
    const fresh = makeDirectory('fresh-project');
    saveUserDirectory({ name: 'Mine', path: userDir });
    seedTranscript('proj-host', hostDir);
    seedTranscript('proj-user', userDir);
    seedTranscript('proj-fresh', fresh);

    expect(collectDirectorySuggestions(provider, [{ name: 'host', path: hostDir }])).toEqual([
      fresh,
    ]);
  });

  /** Pins a transcript's mtime to a deterministic point on a shared clock. */
  function setLastActive(transcriptPath: string, minute: number): void {
    const stamp = new Date(2026, 0, 1, 0, minute);
    fs.utimesSync(transcriptPath, stamp, stamp);
  }

  it('orders suggestions by recency, the last-worked-in directory first', () => {
    const stale = makeDirectory('a-stale-project');
    const current = makeDirectory('current-project');
    const middling = makeDirectory('middling-project');
    setLastActive(seedTranscript('proj-stale', stale), 1);
    setLastActive(seedTranscript('proj-current', current), 3);
    setLastActive(seedTranscript('proj-middling', middling), 2);

    expect(collectDirectorySuggestions(provider, [])).toEqual([current, middling, stale]);
  });

  it("a directory is as recent as its newest session, even one whose transcript can't say where it ran", () => {
    const revisited = makeDirectory('revisited-project');
    const between = makeDirectory('between-project');
    setLastActive(seedTranscript('proj-revisited', revisited, { sessionId: 'aged' }), 1);
    setLastActive(seedTranscript('proj-between', between), 2);
    // A newer session in the same directory, recorded without a cwd — its mtime
    // still counts even though the cwd had to come from the older transcript.
    setLastActive(
      seedTranscript('proj-revisited', revisited, {
        sessionId: 'z-fresh',
        lines: [{ type: 'system', subtype: 'init' }],
      }),
      3,
    );

    expect(collectDirectorySuggestions(provider, [])).toEqual([revisited, between]);
  });

  it('caps the list at the limit, dropping the least recently used', () => {
    const surplus = 3;
    const projects: string[] = [];
    for (let i = 0; i < DIRECTORY_SUGGESTION_LIMIT + surplus; i++) {
      const label = String(i).padStart(2, '0');
      const project = makeDirectory(`capped-project-${label}`);
      projects.push(project);
      setLastActive(seedTranscript(`proj-capped-${label}`, project), i);
    }

    // The newest DIRECTORY_SUGGESTION_LIMIT survive, newest first.
    expect(collectDirectorySuggestions(provider, [])).toEqual(projects.slice(surplus).reverse());
  });

  it('reads only the head of a transcript, ignoring a cwd buried megabytes in', () => {
    const buried = makeDirectory('buried-project');
    const sessionDir = path.join(sessionRoot, 'proj-buried');
    fs.mkdirSync(sessionDir);
    const padding = `${JSON.stringify({ type: 'assistant', text: 'x'.repeat(512) })}\n`;
    const repeats = Math.ceil(DIRECTORY_SUGGESTION_HEAD_BYTES / padding.length) + 2;
    fs.writeFileSync(
      path.join(sessionDir, 'session.jsonl'),
      padding.repeat(repeats) + `${JSON.stringify({ type: 'user', cwd: buried })}\n`,
    );

    expect(collectDirectorySuggestions(provider, [])).toEqual([]);
  });

  it('skips malformed and cwd-less transcripts without failing the rest', () => {
    const good = makeDirectory('good-project');
    const brokenDir = path.join(sessionRoot, 'proj-broken');
    fs.mkdirSync(brokenDir);
    fs.writeFileSync(path.join(brokenDir, 'session.jsonl'), 'not json at all\n');
    const emptyDir = path.join(sessionRoot, 'proj-empty');
    fs.mkdirSync(emptyDir);
    fs.writeFileSync(path.join(emptyDir, 'session.jsonl'), '');
    seedTranscript('proj-good', good);

    expect(collectDirectorySuggestions(provider, [])).toEqual([good]);
  });

  it('falls through to a later transcript when the first has no cwd', () => {
    const project = makeDirectory('late-project');
    const sessionDir = path.join(sessionRoot, 'proj-late');
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(
      path.join(sessionDir, 'a-empty.jsonl'),
      `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`,
    );
    fs.writeFileSync(
      path.join(sessionDir, 'b-real.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: project })}\n`,
    );

    expect(collectDirectorySuggestions(provider, [])).toEqual([project]);
  });

  it('ignores files that are not session transcripts', () => {
    const project = makeDirectory('ignored-project');
    const sessionDir = path.join(sessionRoot, 'proj-other');
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(
      path.join(sessionDir, 'notes.json'),
      `${JSON.stringify({ type: 'user', cwd: project })}\n`,
    );

    expect(collectDirectorySuggestions(provider, [])).toEqual([]);
  });

  it('is empty for a provider with no file fallback, and for roots that are not there', () => {
    makeDirectory('some-project');
    expect(collectDirectorySuggestions({}, [])).toEqual([]);
    expect(
      collectDirectorySuggestions(
        { getAllSessionRoots: () => [path.join(tempHome, 'no-such-root')] },
        [],
      ),
    ).toEqual([]);
  });
});
