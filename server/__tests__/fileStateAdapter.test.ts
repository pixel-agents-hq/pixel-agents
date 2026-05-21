import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PersistedAgent } from '../../core/src/schemas.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';

describe('FileStateAdapter', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-adapter-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── Settings (shared config.json, per-namespace section) ────

  it('returns defaults when config file does not exist', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.getSetting('pixel-agents.soundEnabled', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.watchAllSessions', true)).toBe(false);
    expect(adapter.getSetting('pixel-agents.lastSeenVersion', 'x')).toBe('');
  });

  it('round-trips each of the 6 setting keys', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });

    adapter.setSetting('pixel-agents.soundEnabled', false);
    adapter.setSetting('pixel-agents.lastSeenVersion', '1.3');
    adapter.setSetting('pixel-agents.alwaysShowLabels', true);
    adapter.setSetting('pixel-agents.watchAllSessions', true);
    adapter.setSetting('pixel-agents.hooksEnabled', false);
    adapter.setSetting('pixel-agents.hooksInfoShown', true);

    expect(adapter.getSetting('pixel-agents.soundEnabled', true)).toBe(false);
    expect(adapter.getSetting('pixel-agents.lastSeenVersion', '')).toBe('1.3');
    expect(adapter.getSetting('pixel-agents.alwaysShowLabels', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.watchAllSessions', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.hooksEnabled', true)).toBe(false);
    expect(adapter.getSetting('pixel-agents.hooksInfoShown', false)).toBe(true);
  });

  it('vscode and standalone namespaces are isolated in config.json', () => {
    const vscode = new FileStateAdapter({ namespace: 'vscode' });
    const standalone = new FileStateAdapter({ namespace: 'standalone' });

    vscode.setSetting('pixel-agents.watchAllSessions', true);
    standalone.setSetting('pixel-agents.watchAllSessions', false);

    expect(vscode.getSetting('pixel-agents.watchAllSessions', null)).toBe(true);
    expect(standalone.getSetting('pixel-agents.watchAllSessions', null)).toBe(false);

    const configPath = path.join(tempHome, '.pixel-agents', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(parsed.vscode.watchAllSessions).toBe(true);
    expect(parsed.standalone.watchAllSessions).toBe(false);
  });

  it('ignores unknown setting keys (returns default, does not write)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.getSetting('pixel-agents.unknownKey', 'fallback')).toBe('fallback');
    adapter.setSetting('pixel-agents.unknownKey', 'ignored');
    const configPath = path.join(tempHome, '.pixel-agents', 'config.json');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('accepts setting keys with or without the pixel-agents. prefix', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.setSetting('pixel-agents.soundEnabled', false);
    expect(adapter.getSetting('soundEnabled', true)).toBe(false);
    adapter.setSetting('lastSeenVersion', '1.0');
    expect(adapter.getSetting('pixel-agents.lastSeenVersion', '')).toBe('1.0');
  });

  it('persists settings under namespace in config.json with clean field names', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.setSetting('pixel-agents.soundEnabled', false);
    const configPath = path.join(tempHome, '.pixel-agents', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    expect(parsed.standalone.soundEnabled).toBe(false);
    expect(parsed.standalone['pixel-agents.soundEnabled']).toBeUndefined();
  });

  // ── Per-namespace state file (agents + seats) ───────────────

  it('returns empty arrays/objects when state file does not exist', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.loadAgents()).toEqual([]);
    expect(adapter.loadSeats()).toEqual({});
  });

  it('round-trips agents to the namespace-specific state file', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    const agents: PersistedAgent[] = [
      {
        id: 1,
        sessionId: 'sess-1',
        terminalName: 'Claude Code #1',
        jsonlFile: '/tmp/sess-1.jsonl',
        projectDir: '/tmp/proj',
      },
    ];
    adapter.saveAgents(agents);
    expect(adapter.loadAgents()).toEqual(agents);
  });

  it('writes state at ~/.pixel-agents/<namespace>-state.json', () => {
    const adapter = new FileStateAdapter({ namespace: 'vscode' });
    adapter.saveSeats({ '1': { palette: 2, hueShift: 45 } });
    const stateFile = path.join(tempHome, '.pixel-agents', 'vscode-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it('vscode and standalone state files are independent', () => {
    const vscode = new FileStateAdapter({ namespace: 'vscode' });
    const standalone = new FileStateAdapter({ namespace: 'standalone' });
    const agentVs: PersistedAgent[] = [
      { id: 1, terminalName: 'A', jsonlFile: '/a.jsonl', projectDir: '/proj' },
    ];
    const agentSa: PersistedAgent[] = [
      { id: 9, terminalName: '', jsonlFile: '/b.jsonl', projectDir: '/proj' },
    ];
    vscode.saveAgents(agentVs);
    standalone.saveAgents(agentSa);
    expect(vscode.loadAgents()).toEqual(agentVs);
    expect(standalone.loadAgents()).toEqual(agentSa);
  });

  it('preserves seats when saving agents (and vice versa)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.saveSeats({ '1': { palette: 3 } });
    adapter.saveAgents([{ id: 1, terminalName: 'x', jsonlFile: '/x.jsonl', projectDir: '/tmp' }]);
    expect(adapter.loadSeats()).toEqual({ '1': { palette: 3 } });
    expect(adapter.loadAgents()).toHaveLength(1);
  });
});
