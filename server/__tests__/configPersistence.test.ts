import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearHooksAnswer,
  clearHooksEnabled,
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  parseAreaMappings,
  parseUserDirectories,
  readConfig,
  recordHooksDecline,
  resetHooksConfig,
  setHooksEnabled,
  writeConfig,
} from '../src/configPersistence.js';

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

    it('preserves empty arrays as a deliberate "directory has no preferred area" signal', () => {
      const input = { frontend: [] };
      expect(parseAreaMappings(input)).toEqual({ frontend: [] });
    });
  });

  // ── per-provider hooks consent + preference ──────────────────

  describe('hooksConsent / hooksEnabled maps', () => {
    it('defaults to unanswered/enabled when the config file is missing or predates the maps', () => {
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      writeConfig(readConfig()); // full config on disk...
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      delete raw.hooksConsent; // ...from an older shape
      delete raw.hooksEnabled;
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'config.json'),
        JSON.stringify(raw, null, 2),
      );
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
    });

    it('drops junk values from hand-edited maps instead of crashing or trusting them', () => {
      fs.mkdirSync(path.join(tempHome, '.pixel-agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'config.json'),
        JSON.stringify({
          hooksConsent: { claude: 'GRANTED', other: 'declined', junk: 42 },
          hooksEnabled: { claude: 'yes', other: false },
        }),
      );
      // Only exact values survive; everything else degrades to the default.
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksConsent('other')).toBe('declined');
      expect(getHooksConsent('junk')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      expect(getHooksEnabled('other')).toBe(false);
    });

    it('grantHooksConsent persists per provider and is idempotent', () => {
      grantHooksConsent('claude');
      expect(getHooksConsent('claude')).toBe('granted');
      expect(getHooksConsent('other')).toBe('unanswered');
      grantHooksConsent('claude');
      expect(getHooksConsent('claude')).toBe('granted');
    });

    it('recordHooksDecline writes consent + preference in ONE cycle; clearHooksAnswer undoes both', () => {
      grantHooksConsent('claude');
      recordHooksDecline('claude');
      expect(getHooksConsent('claude')).toBe('declined');
      expect(getHooksEnabled('claude')).toBe(false);
      clearHooksAnswer('claude');
      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      // Both keys are genuinely gone — "never answered" and "answered and
      // reverted" must be indistinguishable on disk.
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      expect('claude' in (raw.hooksConsent ?? {})).toBe(false);
      expect('claude' in (raw.hooksEnabled ?? {})).toBe(false);
    });

    // Review finding I1 (sol): never→install(fails)→notNow stranded the ask.
    // Install is an absolute state command, so a grant REPLACING a decline
    // deletes the decline's hooks-off remnant in the same write — a failed
    // install then leaves granted + default-enabled, which a later notNow
    // revert fully takes back (the ask returns).
    it('a grant replacing a decline clears the decline preference remnant', () => {
      recordHooksDecline('claude');
      expect(getHooksEnabled('claude')).toBe(false);
      grantHooksConsent('claude');
      expect(getHooksConsent('claude')).toBe('granted');
      expect(getHooksEnabled('claude')).toBe(true);
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      expect('claude' in (raw.hooksEnabled ?? {})).toBe(false);
    });

    // A grant must NOT clobber a Settings toggle-off: the preference delete is
    // scoped to replacing a DECLINE, whose hooks-off was the answer's write.
    it('a repeat grant leaves a toggle-written preference alone', () => {
      grantHooksConsent('claude');
      setHooksEnabled('claude', false); // the Settings toggle, not an answer
      grantHooksConsent('claude'); // idempotent repeat
      expect(getHooksEnabled('claude')).toBe(false);
    });

    it('clearHooksEnabled removes the key so the default (true) applies again', () => {
      setHooksEnabled('claude', false);
      expect(getHooksEnabled('claude')).toBe(false);
      clearHooksEnabled('claude');
      expect(getHooksEnabled('claude')).toBe(true);
      // The key is genuinely gone, not written back as true: "never answered"
      // and "answered and reverted" must be indistinguishable on disk.
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      );
      expect('claude' in (raw.hooksEnabled ?? {})).toBe(false);
    });

    it('resetHooksConfig returns all hooks choices to factory state (uninstall → ask again)', () => {
      grantHooksConsent('claude');
      recordHooksDecline('other');
      setHooksEnabled('claude', false); // a persisted "off" must not survive uninstall,
      setHooksEnabled('other', false); // or the next install never prompts
      const cfg = readConfig();
      cfg.vscode.hooksInfoShown = true;
      cfg.standalone.hooksInfoShown = true;
      writeConfig(cfg);

      resetHooksConfig();

      expect(getHooksConsent('claude')).toBe('unanswered');
      expect(getHooksConsent('other')).toBe('unanswered');
      expect(getHooksEnabled('claude')).toBe(true);
      expect(getHooksEnabled('other')).toBe(true);
      const reset = readConfig();
      expect(reset.vscode.hooksInfoShown).toBe(false);
      expect(reset.standalone.hooksInfoShown).toBe(false);
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

    it('defaults bypassPermissions off and coerces a non-boolean back to it', () => {
      expect(readConfig().standalone.bypassPermissions).toBe(false);

      const configDir = path.join(tempHome, '.pixel-agents');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          vscode: { bypassPermissions: 'sure' },
          standalone: { bypassPermissions: true },
        }),
        'utf-8',
      );

      const cfg = readConfig();
      expect(cfg.vscode.bypassPermissions).toBe(false);
      expect(cfg.standalone.bypassPermissions).toBe(true);
    });

    it('defaults the Directory tier to an empty list', () => {
      const cfg = readConfig();
      expect(cfg.directories).toEqual([]);
    });

    it('round-trips user-defined Directories (shared, not per-namespace)', () => {
      const cfg = readConfig();
      cfg.directories = [
        { name: 'Frontend', path: '/tmp/frontend' },
        { name: 'Backend', path: '/tmp/backend' },
      ];
      writeConfig(cfg);

      const reloaded = readConfig();
      expect(reloaded.directories).toEqual([
        { name: 'Frontend', path: '/tmp/frontend' },
        { name: 'Backend', path: '/tmp/backend' },
      ]);
    });

    it('coerces a hand-edited config.json with malformed Directory entries', () => {
      const configDir = path.join(tempHome, '.pixel-agents');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          directories: [
            { name: 'Good', path: '/tmp/good' },
            { name: 'Nameless' },
            { path: '/tmp/pathless-name-missing' },
            { name: 42, path: '/tmp/bad-name' },
            'not-an-object',
            null,
          ],
        }),
        'utf-8',
      );

      const cfg = readConfig();
      expect(cfg.directories).toEqual([{ name: 'Good', path: '/tmp/good' }]);
    });

    it('parseUserDirectories drops anything that is not a named path', () => {
      expect(parseUserDirectories(null)).toEqual([]);
      expect(parseUserDirectories({ name: 'x', path: '/tmp' })).toEqual([]);
      expect(parseUserDirectories([{ name: 'x', path: '' }])).toEqual([]);
      expect(parseUserDirectories([{ name: 'x', path: '/tmp' }])).toEqual([
        { name: 'x', path: '/tmp' },
      ]);
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
