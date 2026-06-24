import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseAreaMappings, readConfig, writeConfig } from '../src/configPersistence.js';

describe('configPersistence: areas', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-config-test-'));
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

  // ── parseAreaMappings ────────────────────────────────────────

  describe('parseAreaMappings', () => {
    it('returns empty object for non-object input (null, undefined, primitives)', () => {
      expect(parseAreaMappings(null)).toEqual({});
      expect(parseAreaMappings(undefined)).toEqual({});
      expect(parseAreaMappings(42)).toEqual({});
      expect(parseAreaMappings('foo')).toEqual({});
      expect(parseAreaMappings(true)).toEqual({});
    });

    it('accepts a valid Record<string, string[]>', () => {
      const input = {
        frontend: ['Engineering'],
        'design-system': ['Engineering', 'Design'],
      };
      expect(parseAreaMappings(input)).toEqual(input);
    });

    it('drops entries whose value is not an array', () => {
      const input = {
        frontend: ['Engineering'],
        bad: 'not-an-array',
        worse: { nested: 'object' },
        broken: 42,
      };
      expect(parseAreaMappings(input)).toEqual({ frontend: ['Engineering'] });
    });

    it('filters non-string entries inside the array', () => {
      const input = {
        frontend: ['Engineering', 42, null, 'Platform', { x: 1 }],
      };
      expect(parseAreaMappings(input)).toEqual({
        frontend: ['Engineering', 'Platform'],
      });
    });

    it('handles a mixed valid/malformed payload by retaining only the valid keys', () => {
      const input = {
        frontend: ['Engineering'],
        backend: ['Platform', 'SRE'],
        bogus_value: 12345,
        bogus_array: ['ok', false, 'also-ok'],
      };
      expect(parseAreaMappings(input)).toEqual({
        frontend: ['Engineering'],
        backend: ['Platform', 'SRE'],
        bogus_array: ['ok', 'also-ok'],
      });
    });

    it('preserves empty arrays as a deliberate "folder has no preferred area" signal', () => {
      const input = { frontend: [] };
      expect(parseAreaMappings(input)).toEqual({ frontend: [] });
    });
  });

  // ── readConfig / writeConfig round-trip ──────────────────────

  describe('readConfig + writeConfig round-trip for area settings', () => {
    it('returns defaults (showAreas=false, areaMappings={}) when no config file exists', () => {
      const cfg = readConfig();
      expect(cfg.vscode.showAreas).toBe(false);
      expect(cfg.vscode.areaMappings).toEqual({});
      expect(cfg.standalone.showAreas).toBe(false);
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('round-trips showAreas + areaMappings per-namespace independently', () => {
      const cfg = readConfig();
      cfg.vscode.showAreas = true;
      cfg.vscode.areaMappings = { frontend: ['Engineering'] };
      cfg.standalone.showAreas = false;
      cfg.standalone.areaMappings = { backend: ['Platform'] };
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.vscode.showAreas).toBe(true);
      expect(reloaded.vscode.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(reloaded.standalone.showAreas).toBe(false);
      expect(reloaded.standalone.areaMappings).toEqual({ backend: ['Platform'] });
    });

    it('coerces a hand-edited config.json with malformed areaMappings into defaults', () => {
      const configDir = path.join(tempHome, '.pixel-agents');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          vscode: { showAreas: 'yes please', areaMappings: 'not-an-object' },
          standalone: { showAreas: true, areaMappings: { frontend: 'broken' } },
        }),
        'utf-8',
      );

      const cfg = readConfig();
      // showAreas: 'yes please' is not a boolean → default false
      expect(cfg.vscode.showAreas).toBe(false);
      expect(cfg.vscode.areaMappings).toEqual({});
      // showAreas: true is valid; areaMappings.frontend: 'broken' is not an array → dropped
      expect(cfg.standalone.showAreas).toBe(true);
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('keeps namespaces isolated when only one writes mappings', () => {
      const cfg = readConfig();
      cfg.vscode.areaMappings = { frontend: ['Engineering'] };
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.vscode.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(reloaded.standalone.areaMappings).toEqual({});
    });
  });
});
