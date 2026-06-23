import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fileWatcher.ts does `import * as vscode from 'vscode'` at module load; the 'vscode'
// package only resolves inside the extension host. Stub the two APIs fileWatcher actually
// touches at runtime (vscode.window.activeTerminal / terminals) so the module loads
// under vitest. Must be declared BEFORE the fileWatcher import.
vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
  },
}));

import { AgentStateStore } from '../src/agentStateStore.js';
import { DISMISSED_COOLDOWN_MS, EXTERNAL_ACTIVE_THRESHOLD_MS } from '../src/constants.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import { scanExternalDir, scanForNewJsonlFiles, setDismissalTracker } from '../src/fileWatcher.js';

/**
 * Tests for the DismissalTracker integration with fileWatcher's scanner functions.
 * These were originally written against the raw module-global Maps (Pre-P2) and
 * now exercise the same behavior via the DismissalTracker class. If any assertion
 * flips compared to the original, the tracker has a behavioral regression.
 */

describe('fileWatcher dismissal state', () => {
  let tmpDir: string;
  let projectDir: string;
  let tracker: DismissalTracker;
  let knownJsonlFiles: Set<string>;
  let nextAgentIdRef: { current: number };
  let agents: AgentStateStore;
  let fileWatchers: Map<number, fs.FSWatcher>;
  let pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;

  function writeJsonlFile(name: string, content: string): string {
    const filePath = path.join(projectDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function runExternalScan(): void {
    scanExternalDir(
      projectDir,
      knownJsonlFiles,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => {},
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-fw-dismissal-'));
    projectDir = tmpDir;

    tracker = new DismissalTracker();
    setDismissalTracker(tracker);

    knownJsonlFiles = new Set();
    nextAgentIdRef = { current: 1 };
    agents = new AgentStateStore();
    fileWatchers = new Map();
    pollingTimers = new Map();
    waitingTimers = new Map();
    permissionTimers = new Map();
  });

  afterEach(() => {
    for (const t of pollingTimers.values()) clearInterval(t);
    for (const t of waitingTimers.values()) clearTimeout(t);
    for (const t of permissionTimers.values()) clearTimeout(t);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── dismissedJsonlFiles: user-close cooldown ───────────────────────

  describe('dismissedJsonlFiles: user-close cooldown', () => {
    it('blocks external adoption when dismissed < DISMISSED_COOLDOWN_MS ago', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      // Dismissed 10 seconds ago — well within the 3-minute cooldown window.
      tracker.dismiss(file, Date.now() - 10_000);

      runExternalScan();

      expect(agents.size).toBe(0);
      expect(tracker.isDismissed(file)).toBe(true); // still within cooldown
    });

    it('expires dismissal and allows adoption after cooldown', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      // Dismissed just over the cooldown boundary.
      tracker.dismiss(file, Date.now() - DISMISSED_COOLDOWN_MS - 1_000);

      runExternalScan();

      expect(agents.size).toBe(1);
      expect(tracker.isDismissed(file)).toBe(false); // expired
    });

    it('leaves non-dismissed, recently-modified files adoptable', () => {
      writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      // No dismissal entry at all.
      runExternalScan();
      expect(agents.size).toBe(1);
    });
  });

  // ── clearDismissedFiles: permanent block ───────────────────────────

  describe('clearDismissedFiles: permanent block', () => {
    it('never re-adopts a file in the permanent-dismiss set', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.permanentlyDismiss(file);

      runExternalScan();

      expect(agents.size).toBe(0);
      expect(tracker.isPermanentlyDismissed(file)).toBe(true); // never auto-expires
    });

    it('blocks across multiple scanner invocations', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.permanentlyDismiss(file);

      runExternalScan();
      runExternalScan();
      runExternalScan();

      expect(agents.size).toBe(0);
    });

    it('does NOT prevent adoption of sibling files in the same dir', () => {
      const blocked = writeJsonlFile('old.jsonl', '{"type":"assistant"}\n');
      writeJsonlFile('new.jsonl', '{"type":"assistant"}\n');
      tracker.permanentlyDismiss(blocked);

      runExternalScan();

      // Only the un-blocked file adopts.
      expect(agents.size).toBe(1);
      const adopted = [...agents.values()][0];
      expect(adopted.jsonlFile).toContain('new.jsonl');
    });
  });

  // ── seededMtimes: mtime-change detection ───────────────────────────

  describe('seededMtimes: mtime-change detection (--resume signal)', () => {
    it('leaves seeded file in known set when mtime unchanged', () => {
      const file = writeJsonlFile('seeded.jsonl', '{"type":"assistant"}\n');
      const stat = fs.statSync(file);
      tracker.seedMtime(file, stat.mtimeMs);
      knownJsonlFiles.add(file);

      runExternalScan();

      // Untouched: still seeded, no adoption (already known).
      expect(tracker.hasSeededMtime(file)).toBe(true);
      expect(knownJsonlFiles.has(file)).toBe(true);
      expect(agents.size).toBe(0);
    });

    it('removes seeded file from tracking when mtime changed', () => {
      const file = writeJsonlFile('seeded.jsonl', '{"type":"assistant"}\n');
      // Seed with an OLD mtime so the file looks "modified since seeding".
      tracker.seedMtime(file, fs.statSync(file).mtimeMs - 60_000);
      knownJsonlFiles.add(file);

      runExternalScan();

      // mtime-changed branch removes from BOTH tracking Maps and returns early
      // (no adoption on the same tick — lets agentManager detect /resume first).
      expect(tracker.hasSeededMtime(file)).toBe(false);
      expect(knownJsonlFiles.has(file)).toBe(false);
      expect(agents.size).toBe(0);
    });

    it('does NOT adopt as external on the mtime-change tick', () => {
      // Seeding + mtime change should hand off to the extension's /resume
      // detection, not produce a spurious external agent.
      const file = writeJsonlFile('seeded.jsonl', '{"type":"assistant"}\n');
      tracker.seedMtime(file, fs.statSync(file).mtimeMs - 30_000);
      knownJsonlFiles.add(file);

      runExternalScan();

      expect(agents.size).toBe(0);
    });
  });

  // ── pendingClearFiles: two-tick delay for /clear content ───────────

  describe('pendingClearFiles: two-tick delay for /clear content', () => {
    const clearJsonl = '{"type":"user","content":"/clear</command-name>"}\n';

    it('first tick: /clear file is registered as pending, not adopted', () => {
      const file = writeJsonlFile('sess-clear.jsonl', clearJsonl);

      runExternalScan();

      expect(agents.size).toBe(0);
      expect(tracker.hasPendingClear(file)).toBe(true);
    });

    it('second tick: /clear file is cleared from pending and adopted', () => {
      const file = writeJsonlFile('sess-clear.jsonl', clearJsonl);

      runExternalScan(); // first tick -> pending
      runExternalScan(); // second tick -> adopt

      expect(agents.size).toBe(1);
      expect(tracker.hasPendingClear(file)).toBe(false);
    });

    it('non-/clear file adopts on first tick (no pending delay)', () => {
      writeJsonlFile('sess-plain.jsonl', '{"type":"assistant"}\n');

      runExternalScan();

      expect(agents.size).toBe(1);
    });
  });

  // ── scanForNewJsonlFiles (project-scan helper) ─────────────────────

  describe('scanForNewJsonlFiles: project scanner', () => {
    function runProjectScan(): void {
      scanForNewJsonlFiles(
        projectDir,
        knownJsonlFiles,
        { current: null },
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        () => {},
      );
    }

    it('skips files already in knownJsonlFiles (seeded at startup)', () => {
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      knownJsonlFiles.add(file);

      runProjectScan();

      // No adoption — the file is known, not new.
      expect(agents.size).toBe(0);
    });

    it('skips files expired in dismissedJsonlFiles during project scan', () => {
      // Project scan (used by the internal terminal adoption path) also
      // honors dismissal cooldown. Seed the file as dismissed very recently.
      const file = writeJsonlFile('sess-1.jsonl', '{"type":"assistant"}\n');
      tracker.dismiss(file, Date.now() - 5_000);

      runProjectScan();

      // No active-terminal agent is present, so adoption shouldn't fire regardless.
      // Primarily: dismissal entry should NOT get erased by this pass.
      expect(tracker.isDismissed(file)).toBe(true);
    });
  });

  // ── Constants sanity check ────────────────────────────────────────

  it('constants are within sensible bounds', () => {
    // Guards against accidental changes that would make these tests lie.
    expect(DISMISSED_COOLDOWN_MS).toBeGreaterThan(60_000);
    expect(EXTERNAL_ACTIVE_THRESHOLD_MS).toBeGreaterThan(30_000);
  });
});
