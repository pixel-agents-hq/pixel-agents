import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfig } from '../src/configPersistence.js';
import {
  buildDirectoryUnion,
  directoryAt,
  expandTilde,
  handleDirectoryClientMessage,
  listDirectories,
  removeUserDirectory,
  saveUserDirectory,
  validateDirectoryPath,
} from '../src/directories.js';

/**
 * The shared Directory module both hosts drive. Everything here goes through the
 * real shared config file, with $HOME redirected to a fresh temp dir per test —
 * the same isolation the other config-touching suites use.
 */
describe('directories', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  /** Real directories on disk to point Directories at. */
  let alpha: string;
  let beta: string;

  beforeEach(() => {
    tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-dirs-test-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    alpha = path.join(tempHome, 'alpha');
    beta = path.join(tempHome, 'beta');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Make the next config write fail: the atomic write goes through a `.tmp`
   *  sibling, and a directory squatting on that name makes it throw. */
  function blockConfigWrites(): void {
    const dir = path.join(tempHome, '.pixel-agents');
    fs.mkdirSync(path.join(dir, 'config.json.tmp'), { recursive: true });
  }

  // ── validation ───────────────────────────────────────────────

  describe('validateDirectoryPath', () => {
    it('accepts an existing directory and returns its resolved path', () => {
      expect(validateDirectoryPath(alpha)).toEqual({ ok: true, path: alpha });
    });

    it('expands a leading ~ to the home directory', () => {
      expect(validateDirectoryPath('~/alpha')).toEqual({ ok: true, path: alpha });
      expect(expandTilde('~')).toBe(os.homedir());
    });

    it('rejects a path that does not exist', () => {
      const missing = path.join(tempHome, 'nope');
      const result = validateDirectoryPath(missing);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain(missing);
    });

    it('rejects a path that exists but is a file', () => {
      const file = path.join(tempHome, 'notes.txt');
      fs.writeFileSync(file, 'hi', 'utf-8');
      const result = validateDirectoryPath(file);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/[Nn]ot a directory/);
    });

    it('rejects an empty path', () => {
      expect(validateDirectoryPath('   ').ok).toBe(false);
    });
  });

  // ── union building ───────────────────────────────────────────

  describe('buildDirectoryUnion', () => {
    it('badges each side and keeps both when the paths differ', () => {
      const union = buildDirectoryUnion(
        [{ name: 'Mine', path: alpha }],
        [{ name: 'beta', path: beta }],
      );
      expect(union).toEqual([
        { name: 'beta', path: beta, source: 'host' },
        { name: 'Mine', path: alpha, source: 'user' },
      ]);
    });

    it('dedupes by path with the user-defined entry (and its name) winning', () => {
      const union = buildDirectoryUnion(
        [{ name: 'My Project', path: alpha }],
        [{ name: 'alpha', path: alpha }],
      );
      expect(union).toEqual([{ name: 'My Project', path: alpha, source: 'user' }]);
    });

    it('treats a trailing separator and a ~ path as the same Directory', () => {
      const union = buildDirectoryUnion(
        [{ name: 'My Project', path: `${alpha}${path.sep}` }],
        [{ name: 'alpha', path: '~/alpha' }],
      );
      expect(union).toHaveLength(1);
      expect(union[0].source).toBe('user');
    });

    it('leads with host rows, then user rows, each group alphabetical', () => {
      const gamma = path.join(tempHome, 'gamma');
      fs.mkdirSync(gamma);
      const union = buildDirectoryUnion(
        [
          { name: 'zulu', path: gamma },
          { name: 'alpha', path: alpha },
        ],
        [{ name: 'mike', path: beta }],
      );
      // 'mike' loses alphabetically to 'alpha' but is host-contributed — where
      // this window already is outranks the user's own bookmarks.
      expect(union.map((d) => d.name)).toEqual(['mike', 'alpha', 'zulu']);
    });
  });

  // ── persistence round-trip ───────────────────────────────────

  describe('saveUserDirectory / removeUserDirectory', () => {
    it('persists an added Directory into the shared config and lists it', () => {
      expect(saveUserDirectory({ name: 'Mine', path: alpha })).toEqual({
        ok: true,
        directory: { name: 'Mine', path: alpha },
      });

      expect(readConfig().directories).toEqual([{ name: 'Mine', path: alpha }]);
      expect(listDirectories([])).toEqual([{ name: 'Mine', path: alpha, source: 'user' }]);
    });

    it('stores the expanded path, so ~ never reaches the office', () => {
      saveUserDirectory({ name: 'Mine', path: '~/alpha' });
      expect(readConfig().directories).toEqual([{ name: 'Mine', path: alpha }]);
    });

    it('falls back to the basename when no name is given', () => {
      saveUserDirectory({ name: '   ', path: alpha });
      expect(readConfig().directories).toEqual([{ name: 'alpha', path: alpha }]);
    });

    it('persists nothing when the path is invalid', () => {
      const result = saveUserDirectory({
        name: 'Broken',
        path: path.join(tempHome, 'nope'),
      });
      expect(result.ok).toBe(false);
      expect(readConfig().directories).toEqual([]);
    });

    it('renames and re-points an entry identified by previousPath', () => {
      saveUserDirectory({ name: 'Mine', path: alpha });
      saveUserDirectory({ name: 'Renamed', path: beta, previousPath: alpha });

      expect(readConfig().directories).toEqual([{ name: 'Renamed', path: beta }]);
    });

    it('reports a failed write instead of claiming the Directory was saved', () => {
      blockConfigWrites();

      const result = saveUserDirectory({ name: 'Mine', path: alpha });

      expect(result.ok).toBe(false);
      expect(readConfig().directories).toEqual([]);
    });

    it('stores default characters (deduped, valid indices only) and lists them', () => {
      saveUserDirectory({
        name: 'Mine',
        path: alpha,
        characters: [3, 1, 3, -1, 2.5, 'x', 0],
        characterOrder: 'random',
      });

      const stored = { name: 'Mine', path: alpha, characters: [3, 1, 0], characterOrder: 'random' };
      expect(readConfig().directories).toEqual([stored]);
      expect(listDirectories([])).toEqual([{ ...stored, source: 'user' }]);
    });

    it('stores no character fields when there are no defaults, nor the default order', () => {
      saveUserDirectory({ name: 'Mine', path: alpha, characters: [], characterOrder: 'random' });
      saveUserDirectory({ name: 'Other', path: beta, characters: [2], characterOrder: 'priority' });

      expect(readConfig().directories).toEqual([
        { name: 'Mine', path: alpha },
        { name: 'Other', path: beta, characters: [2] },
      ]);
    });

    it('an edit replaces the defaults with the ones it sends', () => {
      saveUserDirectory({ name: 'Mine', path: alpha, characters: [1, 2] });
      saveUserDirectory({ name: 'Mine', path: alpha, previousPath: alpha, characters: [4] });

      expect(readConfig().directories).toEqual([{ name: 'Mine', path: alpha, characters: [4] }]);
    });

    it('removes an entry without touching the others', () => {
      saveUserDirectory({ name: 'Mine', path: alpha });
      saveUserDirectory({ name: 'Other', path: beta });

      removeUserDirectory(alpha);

      expect(readConfig().directories).toEqual([{ name: 'Other', path: beta }]);
    });
  });

  // ── shared dispatch ──────────────────────────────────────────

  describe('handleDirectoryClientMessage', () => {
    let broadcasts: Array<Record<string, unknown>>;
    let replies: Array<Record<string, unknown>>;

    function deps() {
      return {
        hostDirectories: () => [{ name: 'beta', path: beta }],
        broadcast: (m: Record<string, unknown>) => broadcasts.push(m),
        reply: (m: Record<string, unknown>) => replies.push(m),
        suggestions: () => [alpha],
      };
    }

    beforeEach(() => {
      broadcasts = [];
      replies = [];
    });

    it('ignores messages it does not own', () => {
      expect(handleDirectoryClientMessage({ type: 'launchAgent' }, deps())).toBe(false);
      expect(broadcasts).toEqual([]);
    });

    it('saveDirectory persists and rebroadcasts the whole union', () => {
      const handled = handleDirectoryClientMessage(
        { type: 'saveDirectory', name: 'Mine', path: alpha },
        deps(),
      );

      expect(handled).toBe(true);
      expect(replies).toEqual([
        { type: 'directorySaved', directory: { name: 'Mine', path: alpha, source: 'user' } },
      ]);
      expect(broadcasts).toEqual([
        {
          type: 'directoriesLoaded',
          directories: [
            { name: 'beta', path: beta, source: 'host' },
            { name: 'Mine', path: alpha, source: 'user' },
          ],
        },
      ]);
    });

    it('saveDirectory tells the saver the name and path the host stored, not what was typed', () => {
      // `~` with no name: the host resolves the path and names the entry after
      // the RESOLVED basename. That name is the Area-mapping key, so the office
      // must learn it from here rather than re-derive it from what it sent.
      handleDirectoryClientMessage({ type: 'saveDirectory', name: '', path: '~' }, deps());

      expect(replies).toEqual([
        {
          type: 'directorySaved',
          directory: { name: path.basename(tempHome), path: tempHome, source: 'user' },
        },
      ]);
    });

    it('saveDirectory replies directoryRejected and persists nothing on a bad path', () => {
      const missing = path.join(tempHome, 'nope');

      handleDirectoryClientMessage(
        { type: 'saveDirectory', name: 'Broken', path: missing },
        deps(),
      );

      expect(broadcasts).toEqual([]);
      expect(replies).toHaveLength(1);
      expect(replies[0].type).toBe('directoryRejected');
      expect(replies[0].path).toBe(missing);
      expect(String(replies[0].reason)).toContain(missing);
      expect(readConfig().directories).toEqual([]);
    });

    it('directoryRejected echoes the path exactly as submitted, tilde and all', () => {
      handleDirectoryClientMessage(
        { type: 'saveDirectory', name: 'Broken', path: '~/nope' },
        deps(),
      );

      expect(replies[0].path).toBe('~/nope');
    });

    it('removeDirectory drops the entry and rebroadcasts', () => {
      saveUserDirectory({ name: 'Mine', path: alpha });

      handleDirectoryClientMessage({ type: 'removeDirectory', path: alpha }, deps());

      expect(readConfig().directories).toEqual([]);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].directories).toEqual([{ name: 'beta', path: beta, source: 'host' }]);
    });

    it('saveDirectory reports a failed write as a rejection, not a saved Directory', () => {
      blockConfigWrites();

      handleDirectoryClientMessage({ type: 'saveDirectory', name: 'Mine', path: alpha }, deps());

      // No broadcast: the office treats the rebroadcast list as "saved" and
      // would close the modal over a Directory that never reached the disk.
      expect(broadcasts).toEqual([]);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: 'directoryRejected', path: alpha });
      expect(String(replies[0].reason)).toMatch(/save/i);
      expect(readConfig().directories).toEqual([]);
    });

    it('removeDirectory reports a failed write as a rejection and keeps the entry', () => {
      saveUserDirectory({ name: 'Mine', path: alpha });
      blockConfigWrites();

      handleDirectoryClientMessage({ type: 'removeDirectory', path: alpha }, deps());

      expect(broadcasts).toEqual([]);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: 'directoryRejected', path: alpha });
      expect(readConfig().directories).toEqual([{ name: 'Mine', path: alpha }]);
    });

    it('requestDirectorySuggestions answers only the asking client', () => {
      const handled = handleDirectoryClientMessage({ type: 'requestDirectorySuggestions' }, deps());

      expect(handled).toBe(true);
      expect(broadcasts).toEqual([]);
      expect(replies).toEqual([{ type: 'directorySuggestions', paths: [alpha] }]);
    });
  });

  // ── launch labelling ─────────────────────────────────────────

  describe('directoryAt', () => {
    it('gives a launch the name its Directory was given, not the path basename', () => {
      saveUserDirectory({ name: 'Side Project', path: alpha });

      expect(directoryAt(alpha, [])?.name).toBe('Side Project');
    });

    it('matches regardless of how the launch path was written', () => {
      saveUserDirectory({ name: 'Side Project', path: alpha });

      expect(directoryAt(`${alpha}${path.sep}`, [])?.name).toBe('Side Project');
      expect(directoryAt('~/alpha', [])?.name).toBe('Side Project');
    });

    it('names host-contributed Directories too', () => {
      expect(directoryAt(beta, [{ name: 'beta', path: beta }])?.name).toBe('beta');
    });

    it("prefers the user's name over the host's for the same path", () => {
      saveUserDirectory({ name: 'My Workspace', path: beta });

      expect(directoryAt(beta, [{ name: 'beta', path: beta }])?.name).toBe('My Workspace');
    });

    it('is undefined for a path that is no Directory, so the host keeps its own label', () => {
      expect(directoryAt(alpha, [{ name: 'beta', path: beta }])?.name).toBeUndefined();
    });
  });
});
