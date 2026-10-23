import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { EXTERNAL_SCAN_INTERVAL_MS, GLOBAL_SCAN_ACTIVE_MIN_SIZE } from '../src/constants.js';
import { setDirectoryNameResolver } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { cwdFromTranscript, TRANSCRIPT_CWD_HEAD_BYTES } from '../src/transcriptCwd.js';
import type { PersistedAgent } from '../src/types.js';

/**
 * Claude encodes a project dir by replacing every separator with a dash, so
 * `-tmp-hobbyfi-blog-automation` can't say whether the project was
 * `hobbyfi-blog-automation` or `.../blog/automation`; the old label took the
 * last segment ("automation") and collided across projects. The transcript's
 * own records carry the real cwd: sessions known only by their transcript
 * (scanner adoption, a hook without a cwd, restore) are labelled from it.
 */

function record(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

describe('cwdFromTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-transcript-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(content: string): string {
    const file = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(file, content);
    return file;
  }

  it('returns the first cwd a record carries, skipping records without one', () => {
    const file = write(
      record({ type: 'summary', summary: 'earlier work' }) +
        record({ type: 'user', cwd: '/work/hobbyfi-blog-automation' }) +
        record({ type: 'assistant', cwd: '/work/somewhere-else' }),
    );
    expect(cwdFromTranscript(file)).toBe('/work/hobbyfi-blog-automation');
  });

  it('skips malformed lines and non-string cwds', () => {
    const file = write(
      '{"type":"user", broken\n' +
        record({ type: 'user', cwd: 42 }) +
        record({ type: 'user', cwd: '' }) +
        record({ type: 'user', cwd: '/work/real' }),
    );
    expect(cwdFromTranscript(file)).toBe('/work/real');
  });

  it('reads a final record that has no trailing newline', () => {
    const file = write(JSON.stringify({ type: 'user', cwd: '/work/last' }));
    expect(cwdFromTranscript(file)).toBe('/work/last');
  });

  it('returns undefined for a missing file', () => {
    expect(cwdFromTranscript(path.join(tmpDir, 'nope.jsonl'))).toBeUndefined();
  });

  it('returns undefined when no record carries a cwd', () => {
    const file = write(record({ type: 'summary' }) + record({ type: 'assistant' }));
    expect(cwdFromTranscript(file)).toBeUndefined();
  });

  it('reads only the head: a record cut by the head limit is not parsed', () => {
    // A filler record sized so the cwd record straddles the head limit.
    const cwdLine = record({ type: 'user', cwd: '/work/past-the-head' });
    const overhead = record({ type: 'summary', pad: '' }).length;
    const fillerEnd = TRANSCRIPT_CWD_HEAD_BYTES - Math.floor(cwdLine.length / 2);
    const filler = record({ type: 'summary', pad: 'x'.repeat(fillerEnd - overhead) });
    expect(filler.length).toBe(fillerEnd);
    const file = write(filler + cwdLine);
    expect(cwdFromTranscript(file)).toBeUndefined();
    // The same record inside the head is found.
    fs.writeFileSync(file, record({ type: 'summary', pad: 'x'.repeat(100) }) + cwdLine);
    expect(cwdFromTranscript(file)).toBe('/work/past-the-head');
  });
});

describe('Directory name from the transcript cwd', () => {
  let tmpDir: string;
  let sessionRoot: string;
  let encodedDir: string;
  let realCwd: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-dirname-transcript-'));
    sessionRoot = path.join(tmpDir, 'projects');
    encodedDir = path.join(sessionRoot, '-tmp-hobbyfi-blog-automation');
    fs.mkdirSync(encodedDir, { recursive: true });
    realCwd = path.join(tmpDir, 'work', 'hobbyfi-blog-automation');
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    vi.useRealTimers();
    setDirectoryNameResolver(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A transcript big enough for the global scanner's activity filter (>3 KB). */
  function writeTranscript(withCwd: boolean): string {
    const file = path.join(encodedDir, 'aaaaaaaa-1111-4111-8111-000000000001.jsonl');
    const base = withCwd ? { cwd: realCwd } : {};
    fs.writeFileSync(
      file,
      record({ type: 'summary', summary: 'no cwd on this one' }) +
        record({
          type: 'user',
          ...base,
          message: { role: 'user', content: 'p'.repeat(GLOBAL_SCAN_ACTIVE_MIN_SIZE) },
        }),
    );
    return file;
  }

  function globalScanRuntime(): { store: AgentStateStore } {
    const store = new AgentStateStore();
    const provider: HookProvider = { ...claudeProvider, getAllSessionRoots: () => [sessionRoot] };
    runtime = new AgentRuntime(store, provider);
    runtime.watchAllSessions.current = true;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // The workspace dir is somewhere else: the session is found by the global scan.
    runtime.startExternalScanning(path.join(tmpDir, 'workspace-project-dir'));
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    return { store };
  }

  describe('global scanner adoption', () => {
    it('labels the session with the basename of the cwd its transcript records', () => {
      writeTranscript(true);
      const { store } = globalScanRuntime();
      expect([...store.values()].map((a) => a.directoryName)).toEqual(['hobbyfi-blog-automation']);
    });

    it('falls back to the encoded project dir when the transcript records no cwd', () => {
      writeTranscript(false);
      const { store } = globalScanRuntime();
      expect([...store.values()].map((a) => a.directoryName)).toEqual(['automation']);
    });

    it('lets the host resolver win', () => {
      writeTranscript(true);
      const seen: Array<{ cwd?: string; projectDir?: string }> = [];
      setDirectoryNameResolver((ctx) => {
        seen.push(ctx);
        return 'Workspace A';
      });
      const { store } = globalScanRuntime();
      expect([...store.values()].map((a) => a.directoryName)).toEqual(['Workspace A']);
      // The resolver is handed the real cwd too, not only the lossy encoded dir.
      expect(seen).toEqual([{ cwd: realCwd, projectDir: encodedDir }]);
    });

    it('uses the transcript cwd when the host resolver has no answer', () => {
      writeTranscript(true);
      setDirectoryNameResolver(() => undefined);
      const { store } = globalScanRuntime();
      expect([...store.values()].map((a) => a.directoryName)).toEqual(['hobbyfi-blog-automation']);
    });
  });

  describe('hook adoption without a cwd', () => {
    it('reads the cwd out of the transcript', () => {
      const transcriptPath = writeTranscript(true);
      const store = new AgentStateStore();
      runtime = new AgentRuntime(store, claudeProvider);
      runtime.watchAllSessions.current = true;

      runtime.handleHookEvent('claude', {
        hook_event_name: 'SessionStart',
        session_id: 'no-cwd-1',
        source: 'startup',
        transcript_path: transcriptPath,
      });
      runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'no-cwd-1' });

      expect([...store.values()].map((a) => a.directoryName)).toEqual(['hobbyfi-blog-automation']);
    });
  });

  describe('restoreExternalAgents', () => {
    function createMockAdapter(initial: PersistedAgent[]): StateAdapter & {
      saved: PersistedAgent[][];
    } {
      let current = initial;
      const saved: PersistedAgent[][] = [];
      return {
        saved,
        loadAgents: () => current,
        saveAgents: (agents) => {
          current = agents;
          saved.push(agents);
        },
        loadSeats: () => ({}),
        saveSeats: () => {},
        getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
        setSetting: vi.fn<(key: string, value: unknown) => void>(),
      };
    }

    function restore(jsonlFile: string, directoryName: string) {
      const adapter = createMockAdapter([
        {
          id: 7,
          sessionId: 'sess-restore',
          terminalName: '',
          isExternal: true,
          jsonlFile,
          projectDir: encodedDir,
          directoryName,
        },
      ]);
      const store = new AgentStateStore();
      store.setAdapter(adapter);
      runtime = new AgentRuntime(store, claudeProvider);
      runtime.restoreExternalAgents();
      return { store, adapter };
    }

    it('replaces a persisted encoded-dir guess with the transcript cwd basename', () => {
      const { store, adapter } = restore(writeTranscript(true), 'automation');
      expect(store.get(7)?.directoryName).toBe('hobbyfi-blog-automation');
      // ...and the corrected label is what gets persisted, so it sticks.
      const written = adapter.saved.at(-1)?.find((p) => p.id === 7);
      expect(written?.directoryName).toBe('hobbyfi-blog-automation');
    });

    it('keeps the persisted label when the transcript records no cwd', () => {
      const { store } = restore(writeTranscript(false), 'automation');
      expect(store.get(7)?.directoryName).toBe('automation');
    });

    it('keeps the persisted label when a host resolver is registered', () => {
      setDirectoryNameResolver(() => 'Workspace A');
      const { store } = restore(writeTranscript(true), 'Persisted Name');
      expect(store.get(7)?.directoryName).toBe('Persisted Name');
    });
  });
});
