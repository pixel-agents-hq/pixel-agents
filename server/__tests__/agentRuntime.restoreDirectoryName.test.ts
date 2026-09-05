import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PersistedAgent } from '../src/types.js';

function createMockAdapter(initial: PersistedAgent[] = []): StateAdapter & {
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

/**
 * Releases up to v1.4.x persisted the origin label as `folderName`. The
 * Directory rename reads `directoryName`, so without a fallback the first
 * start after an upgrade would restore every agent from the previous session
 * with no label and no Area-mapping key. Same mock-adapter shape as
 * agentRuntime.restorePalette.test.ts; disk is touched only for the
 * jsonlFile existence gate.
 */
describe('AgentRuntime -- restore reads the legacy folderName', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-dir-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(jsonlPath, '');
  });

  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function restore(record: Partial<PersistedAgent>): {
    store: AgentStateStore;
    adapter: ReturnType<typeof createMockAdapter>;
  } {
    const adapter = createMockAdapter([
      {
        id: 7,
        sessionId: 'sess-restore',
        terminalName: '',
        isExternal: true,
        jsonlFile: jsonlPath,
        projectDir: tmpDir,
        ...record,
      },
    ]);
    const store = new AgentStateStore();
    store.setAdapter(adapter);
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.restoreExternalAgents();
    return { store, adapter };
  }

  it('a pre-rename record with only folderName restores with that as directoryName', () => {
    const { store } = restore({ folderName: 'Pixel Agents' });
    expect(store.get(7)?.directoryName).toBe('Pixel Agents');
  });

  it('directoryName wins when both spellings are present', () => {
    const { store } = restore({ directoryName: 'New Name', folderName: 'Old Name' });
    expect(store.get(7)?.directoryName).toBe('New Name');
  });

  it('a record with neither still restores, unlabelled', () => {
    const { store } = restore({});
    expect(store.get(7)).toBeDefined();
    expect(store.get(7)?.directoryName).toBeUndefined();
  });

  it('the next persist rewrites the legacy record as directoryName only', () => {
    const { store, adapter } = restore({ folderName: 'Pixel Agents' });
    store.persist();
    const written = adapter.saved.at(-1)?.find((p) => p.id === 7);
    expect(written?.directoryName).toBe('Pixel Agents');
    expect(written).not.toHaveProperty('folderName');
  });
});
