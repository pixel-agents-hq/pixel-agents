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
import {
  DISMISSED_COOLDOWN_MS,
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
} from '../src/constants.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  scanExternalDir,
  scanForNewJsonlFiles,
  setDismissalTracker,
  setTeamProvider,
  startExternalSessionScanning,
} from '../src/fileWatcher.js';
import { PathSet } from '../src/pathKey.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import type { AgentState } from '../src/types.js';

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
  // PathSet, not Set — mirrors AgentRuntime.knownJsonlFiles so the case-varied
  // path cases below exercise the real membership semantics.
  let knownJsonlFiles: PathSet;
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

  function runExternalScan(hooksEnabled = false): void {
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
      { current: hooksEnabled },
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-fw-dismissal-'));
    projectDir = tmpDir;

    tracker = new DismissalTracker();
    setDismissalTracker(tracker);

    knownJsonlFiles = new PathSet();
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

  describe('scanExternalDir: team session ownership', () => {
    it('leaves a tracked lead’s teammate session to team discovery', () => {
      // Newer harnesses run each spawned agent as its own top-level session in
      // the LEAD's projectDir, so this scan sees it too. Generic adoption here
      // would strip the teammate identity (no leadAgentId, and a seat picked by
      // findFreeSeat rather than the seat closest to its lead), and since
      // workspace polling runs under hooks it can beat the hook-driven attach.
      setTeamProvider(claudeTeamProvider);
      try {
        const teamName = 'session-abc12345';
        const leadFile = writeJsonlFile('lead.jsonl', '{"type":"assistant"}\n');
        knownJsonlFiles.add(leadFile);
        nextAgentIdRef.current = 50;
        agents.set(1, {
          id: 1,
          jsonlFile: leadFile,
          projectDir,
          isExternal: false,
          teamName,
        } as AgentState);

        writeJsonlFile(
          'aaaaaaaa-1111-4111-8111-e2e000000001.jsonl',
          `${JSON.stringify({ type: 'system', teamName, agentName: 'researcher' })}\n`,
        );

        runExternalScan(true);

        // The teammate transcript must be left for team discovery. Asserted on
        // the adopted FILES, not the store size: the scanner assigns ids from
        // nextAgentIdRef, which can collide with a hand-seeded lead and mask an
        // adoption as an overwrite.
        const adopted = [...agents.values()].map((a) => path.basename(a.jsonlFile));
        expect(adopted).toEqual(['lead.jsonl']);
      } finally {
        setTeamProvider(null as unknown as Parameters<typeof setTeamProvider>[0]);
      }
    });

    it('still adopts a teammate session when hooks are OFF', () => {
      // Hooks off = no fast-attach, so this scan is the ONLY discovery path for
      // tmux teammates. Guarding on team tags without checking hooks state broke
      // the hooks-off matrix specs: the teammate was never adopted at all.
      setTeamProvider(claudeTeamProvider);
      try {
        const teamName = 'session-abc12345';
        const leadFile = writeJsonlFile('lead.jsonl', '{"type":"assistant"}\n');
        knownJsonlFiles.add(leadFile);
        nextAgentIdRef.current = 50;
        agents.set(1, {
          id: 1,
          jsonlFile: leadFile,
          projectDir,
          isExternal: false,
          teamName,
        } as AgentState);

        writeJsonlFile(
          'cccccccc-3333-4333-8333-e2e000000003.jsonl',
          `${JSON.stringify({ type: 'system', teamName, agentName: 'researcher' })}\n`,
        );

        runExternalScan(false);

        const adopted = [...agents.values()].map((a) => path.basename(a.jsonlFile));
        expect(adopted).toContain('cccccccc-3333-4333-8333-e2e000000003.jsonl');
      } finally {
        setTeamProvider(null as unknown as Parameters<typeof setTeamProvider>[0]);
      }
    });

    it('still adopts an orphan team session whose lead is not tracked', () => {
      setTeamProvider(claudeTeamProvider);
      try {
        writeJsonlFile(
          'bbbbbbbb-2222-4222-8222-e2e000000002.jsonl',
          `${JSON.stringify({ type: 'system', teamName: 'session-orphan1', agentName: 'stray' })}\n`,
        );

        runExternalScan(true);

        const adopted = [...agents.values()].map((a) => path.basename(a.jsonlFile));
        expect(adopted).toEqual(['bbbbbbbb-2222-4222-8222-e2e000000002.jsonl']);
      } finally {
        setTeamProvider(null as unknown as Parameters<typeof setTeamProvider>[0]);
      }
    });
  });

  describe('startExternalSessionScanning: hooks mode workspace discovery', () => {
    it('adopts workspace JSONL sessions when hooks and Watch All Sessions are both enabled', () => {
      vi.useFakeTimers();
      const projectScanTimerRef: { current: ReturnType<typeof setInterval> | null } = {
        current: null,
      };

      ensureProjectScan(
        projectDir,
        knownJsonlFiles,
        projectScanTimerRef,
        { current: null },
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        () => {},
        undefined,
        { current: true },
      );
      writeJsonlFile('workspace-session.jsonl', '{"type":"assistant"}\n');

      const externalScanTimer = startExternalSessionScanning(
        projectDir,
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        new Map(),
        () => {},
        { current: true },
        { current: true },
      );

      vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);

      clearInterval(externalScanTimer);
      if (projectScanTimerRef.current) clearInterval(projectScanTimerRef.current);
      vi.useRealTimers();

      expect(agents.size).toBe(1);
      const adopted = [...agents.values()][0];
      expect(adopted.jsonlFile).toBe(path.join(projectDir, 'workspace-session.jsonl'));
      expect(adopted.isExternal).toBe(true);
    });

    it('does not steal a replacement transcript while an agent awaits reassignment', () => {
      const oldFile = writeJsonlFile('old-session.jsonl', '{"type":"assistant"}\n');
      const replacementFile = writeJsonlFile('replacement-session.jsonl', '{"type":"assistant"}\n');
      knownJsonlFiles.add(oldFile);
      agents.set(1, {
        id: 1,
        isExternal: false,
        projectDir,
        jsonlFile: oldFile,
        pendingClear: true,
      } as AgentState);
      nextAgentIdRef.current = 2;

      runExternalScan();
      expect(agents.size).toBe(1);
      expect(knownJsonlFiles.has(replacementFile)).toBe(false);

      agents.get(1)!.pendingClear = false;
      runExternalScan();
      expect(agents.size).toBe(2);
      expect(knownJsonlFiles.has(replacementFile)).toBe(true);
    });

    it('honors a dismissal recorded under a different path spelling', () => {
      // Windows only: the user closes a hook-adopted agent (Claude's spelling of the
      // transcript path) and the scanner then rediscovers the same file under VS Code's
      // spelling. An exact-string dismissal key missed and the file was re-adopted
      // seconds later, mid-cooldown.
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const file = writeJsonlFile('closed-session.jsonl', '{"type":"assistant"}\n');
        tracker.dismiss(file.toUpperCase());

        runExternalScan();

        expect(agents.size).toBe(0);
        expect(tracker.isDismissed(file)).toBe(true);
      } finally {
        platformSpy.mockRestore();
      }
    });

    it('treats a case-varied transcript as already known', () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const file = writeJsonlFile('known-session.jsonl', '{"type":"assistant"}\n');
        knownJsonlFiles.add(file.toUpperCase());

        runExternalScan();

        expect(agents.size).toBe(0);
      } finally {
        platformSpy.mockRestore();
      }
    });

    it('deduplicates case-varied transcript paths across hook and polling adoption', () => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        const file = writeJsonlFile('workspace-session.jsonl', '{"type":"assistant"}\n');
        agents.set(1, {
          id: 1,
          isExternal: true,
          projectDir,
          jsonlFile: file.toUpperCase(),
        } as AgentState);
        nextAgentIdRef.current = 2;

        adoptExternalSessionFromHook(
          'workspace-session',
          file,
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
        runExternalScan();

        expect(agents.size).toBe(1);
        expect(nextAgentIdRef.current).toBe(2);
      } finally {
        platformSpy.mockRestore();
      }
    });
  });

  // ── Constants sanity check ────────────────────────────────────────

  it('constants are within sensible bounds', () => {
    // Guards against accidental changes that would make these tests lie.
    expect(DISMISSED_COOLDOWN_MS).toBeGreaterThan(60_000);
    expect(EXTERNAL_ACTIVE_THRESHOLD_MS).toBeGreaterThan(30_000);
  });
});
