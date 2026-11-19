/**
 * Directories as the Pixel Office MCP reads and edits them (list_directories,
 * edit_directories): what the Directory modal does, for agents. A Directory is
 * listed with everything that modal shows — its name and path, the Areas it is
 * mapped to, its default characters and their order, its Worktree settings —
 * and a batch of ops adds, edits or removes the user's own ones.
 *
 * A batch is all or none: the ops run in order on a copy (the user's
 * Directories, this office's Area mappings), every check the modal's save
 * runs (directories.ts `withUserDirectory`), and only a batch that passes
 * whole is written — the Directories in one config write, then the mappings —
 * and shown in every office.
 */

import { z } from 'zod';

import type { CharacterProfile } from '../../../core/src/characterProfiles.js';
import { characterIdOf } from '../../../core/src/characterProfiles.js';
import { MAX_DIRECTORY_CHARACTERS } from '../../../core/src/directoryCharacters.js';
import type { UserDirectory } from '../configPersistence.js';
import { DIRECTORY_WRITE_FAILED_REASON } from '../constants.js';
import { normalizeDirectoryPath, withUserDirectory } from '../directories.js';
import { type CharacterRef, findCharacter } from './charactersView.js';
import type { AreaMappings } from './layoutEditOps.js';
import { sameMappings } from './layoutEditOps.js';
import type { DirectoryEditOutcome, DirectoryOps, OfficeDirectory } from './officeOperations.js';

// ── The ops ─────────────────────────────────────────────────

const directoryRef = z.string().min(1).describe("A Directory's name, or its path.");
const settings = {
  characters: z
    .array(z.union([z.string().min(1), z.number().int()]))
    .max(MAX_DIRECTORY_CHARACTERS)
    .optional()
    .describe(
      'Its default characters, highest priority first (ids, exact names or palette indices): ' +
        'the whole list, [] for none.',
    ),
  character_order: z
    .enum(['priority', 'random'])
    .optional()
    .describe('Which default a launch wears: the first no agent wears, or a random unworn one.'),
  areas: z
    .array(z.string().min(1))
    .optional()
    .describe('The Areas its agents sit in (labels): the whole list, [] for none.'),
  worktree_base: z
    .enum(['head', 'fresh'])
    .optional()
    .describe(
      "What its new Worktrees start from: its checkout's HEAD, or origin's default branch.",
    ),
  worktree_branch_prefix: z
    .string()
    .optional()
    .describe("Put before a new Worktree's name to make its branch ('' for none)."),
};

export const directoryOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    path: z.string().min(1).describe('An existing folder: absolute, or under ~.'),
    name: z.string().optional().describe("Defaults to the folder's name."),
    ...settings,
  }),
  z.object({
    op: z.literal('update'),
    directory: directoryRef,
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    ...settings,
  }),
  z.object({ op: z.literal('remove'), directory: directoryRef }),
]);

export type DirectoryOp = z.infer<typeof directoryOpSchema>;

// ── What the module needs of the office ─────────────────────

export interface DirectoryOpsDeps {
  /** The user's own Directories, as stored (config.json). */
  userDirectories(): readonly UserDirectory[];
  /** Every Directory of this office, the host's own among them (name → path). */
  officeDirectories(): ReadonlyArray<{ name: string; path: string }>;
  /** Replace the user's Directories in one write; false when it failed. */
  writeUserDirectories(directories: readonly UserDirectory[]): boolean;
  profiles(): readonly CharacterProfile[];
  /** The layout's Area labels. */
  areas(): readonly string[];
  readAreaMappings(): AreaMappings;
  writeAreaMappings(mappings: AreaMappings): void;
  /** Whether a folder is a git repo (its Worktree settings mean something). */
  isRepo(path: string): boolean;
  /** The Directories were written: re-send them to every office. */
  directoriesChanged(): void;
  /** The Area mappings were written: show them in every office. */
  mappingsChanged(mappings: AreaMappings): void;
}

class OpRefused extends Error {}
function refuse(reason: string): never {
  throw new OpRefused(reason);
}

/** A Directory of the office during a batch: the user's own entry, or the host's. */
type Listed =
  | { source: 'user'; entry: UserDirectory }
  | { source: 'host'; entry: { name: string; path: string } };

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The office's Directories: the user's, then the host's no user entry sits on. */
function listed(
  users: readonly UserDirectory[],
  office: ReadonlyArray<{ name: string; path: string }>,
): Listed[] {
  const userPaths = new Set(users.map((d) => normalizeDirectoryPath(d.path)));
  return [
    ...users.map((entry): Listed => ({ source: 'user', entry })),
    ...office
      .filter((d) => !userPaths.has(normalizeDirectoryPath(d.path)))
      .map((entry): Listed => ({ source: 'host', entry })),
  ];
}

export function createDirectoryOps(deps: DirectoryOpsDeps): DirectoryOps {
  /** The host's own Directories: the office's that the user did not define. */
  const hostDirectories = (): Array<{ name: string; path: string }> =>
    listed(deps.userDirectories(), deps.officeDirectories()).flatMap((d) =>
      d.source === 'host' ? [d.entry] : [],
    );

  function describe(
    directory: Listed,
    mappings: AreaMappings,
    profiles: readonly CharacterProfile[],
  ): OfficeDirectory {
    const { entry } = directory;
    const user = directory.source === 'user' ? directory.entry : null;
    return {
      name: entry.name,
      path: entry.path,
      source: directory.source,
      isRepo: deps.isRepo(entry.path),
      areas: mappings[entry.name] ?? [],
      characters: (user?.characters ?? []).flatMap((palette) => {
        const profile = profiles[palette];
        return profile
          ? [{ id: characterIdOf(profile, palette), name: profile.name ?? '', palette }]
          : [];
      }),
      characterOrder: user?.characterOrder ?? 'priority',
      worktreeBase: user?.worktreeBase ?? 'head',
      worktreeBranchPrefix: user?.worktreeBranchPrefix ?? '',
    };
  }

  function listDirectories(): OfficeDirectory[] {
    const mappings = deps.readAreaMappings();
    const profiles = deps.profiles();
    return listed(deps.userDirectories(), deps.officeDirectories()).map((d) =>
      describe(d, mappings, profiles),
    );
  }

  function editDirectories(ops: readonly DirectoryOp[]): DirectoryEditOutcome {
    const hosts = hostDirectories();
    const profiles = deps.profiles();
    const areaLabels = deps.areas();
    const before = deps.userDirectories();
    const mappingsBefore = deps.readAreaMappings();
    let users: UserDirectory[] = [...before];
    let mappings: AreaMappings = { ...mappingsBefore };
    const notes: string[] = [];
    /** The paths of the Directories the batch added or changed, in order. */
    const touched: string[] = [];
    const removed: Array<{ name: string; path: string }> = [];

    const all = (): Listed[] => listed(users, hosts);
    const known = (): string =>
      all()
        .map((d) => `"${d.entry.name}"`)
        .join(', ') || 'none';

    const find = (ref: string): Listed => {
      const wanted = ref.trim();
      const directories = all();
      const found =
        directories.find((d) => d.entry.name === wanted) ??
        directories.find((d) => sameName(d.entry.name, wanted)) ??
        directories.find(
          (d) => normalizeDirectoryPath(d.entry.path) === normalizeDirectoryPath(wanted),
        );
      return found ?? refuse(`no Directory "${ref}" (Directories: ${known()})`);
    };

    /** A user Directory to edit: the host's own have no settings to change. */
    const own = (ref: string, doing: string): UserDirectory => {
      const found = find(ref);
      if (found.source === 'host') {
        refuse(
          `"${found.entry.name}" is the folder this office runs in, not one of the user's ` +
            `Directories, so there is nothing to ${doing}: \`add\` its path ` +
            `(${found.entry.path}) to give it a name and settings of its own`,
        );
      }
      return found.entry;
    };

    const palettes = (refs: readonly CharacterRef[]): number[] => {
      const out: number[] = [];
      for (const ref of refs) {
        const character = findCharacter(profiles, ref);
        if (!character.ok) refuse(character.reason);
        if (!out.includes(character.index)) out.push(character.index);
      }
      return out;
    };

    const labels = (areas: readonly string[]): string[] => {
      const out: string[] = [];
      for (const area of areas) {
        const wanted = area.trim().toLowerCase();
        const label = areaLabels.find((a) => a.toLowerCase() === wanted);
        if (label === undefined) {
          const have = areaLabels.map((a) => `"${a}"`).join(', ') || 'none';
          refuse(`no Area "${area}" (Areas: ${have}); edit_layout create_area makes one`);
        }
        if (!out.includes(label)) out.push(label);
      }
      return out;
    };

    /** No other Directory may hold `name`: Area mappings and launches go by it. */
    const nameFree = (directory: UserDirectory, among: readonly UserDirectory[]): void => {
      const clash = listed(among, hosts).find(
        (d) => d.entry !== directory && sameName(d.entry.name, directory.name),
      );
      if (clash) {
        refuse(`another Directory is already called "${clash.entry.name}" (${clash.entry.path})`);
      }
    };

    /** A Directory's name changed (or went): its Area mapping follows, unless
     *  a Directory of the old name is still there. */
    const carryMapping = (from: string, to: string | null): void => {
      if (from === to || !(from in mappings)) return;
      if (all().some((d) => d.entry.name === from)) return;
      const { [from]: areas, ...rest } = mappings;
      mappings = to === null || to in rest ? rest : { ...rest, [to]: areas };
    };

    const setAreas = (name: string, areas: readonly string[] | undefined): void => {
      if (areas === undefined) return;
      const { [name]: _was, ...rest } = mappings;
      const wanted = labels(areas);
      mappings = wanted.length ? { ...rest, [name]: wanted } : rest;
    };

    /** Store one Directory through the modal's own save rules. */
    const store = (
      input: Parameters<typeof withUserDirectory>[1],
      was: { name: string } | null,
      areas: readonly string[] | undefined,
    ): void => {
      const next = withUserDirectory(users, input);
      if (!next.ok) refuse(next.reason);
      nameFree(next.directory, next.directories);
      users = next.directories;
      if (was) carryMapping(was.name, next.directory.name);
      setAreas(next.directory.name, areas);
      const key = normalizeDirectoryPath(next.directory.path);
      if (!touched.includes(key)) touched.push(key);
    };

    for (const [index, op] of ops.entries()) {
      try {
        switch (op.op) {
          case 'add': {
            const key = normalizeDirectoryPath(op.path);
            const existing = users.find((d) => normalizeDirectoryPath(d.path) === key);
            if (existing) {
              refuse(
                `${existing.path} already is the Directory "${existing.name}": \`update\` changes it`,
              );
            }
            // A host Directory at this path is taken over, its mapping with it.
            const host = hosts.find((d) => normalizeDirectoryPath(d.path) === key) ?? null;
            store(
              {
                name: op.name ?? '',
                path: op.path,
                characters: op.characters && palettes(op.characters),
                characterOrder: op.character_order,
                worktreeBase: op.worktree_base,
                worktreeBranchPrefix: op.worktree_branch_prefix,
              },
              host,
              op.areas,
            );
            break;
          }
          case 'update': {
            const entry = own(op.directory, 'update');
            if (op.path !== undefined) {
              const key = normalizeDirectoryPath(op.path);
              const other = users.find(
                (d) => d !== entry && normalizeDirectoryPath(d.path) === key,
              );
              if (other) refuse(`${other.path} already is the Directory "${other.name}"`);
            }
            store(
              {
                name: op.name ?? entry.name,
                path: op.path ?? entry.path,
                previousPath: entry.path,
                characters: op.characters ? palettes(op.characters) : entry.characters,
                characterOrder: op.character_order ?? entry.characterOrder,
                worktreeBase: op.worktree_base ?? entry.worktreeBase,
                worktreeBranchPrefix: op.worktree_branch_prefix ?? entry.worktreeBranchPrefix,
              },
              entry,
              op.areas,
            );
            if (op.character_order === 'random' && !(op.characters ?? entry.characters)?.length) {
              notes.push(
                `op ${index}: "${op.name ?? entry.name}" has no default characters, so its ` +
                  'character order was not kept (it is stored with them)',
              );
            }
            break;
          }
          case 'remove': {
            const entry = own(op.directory, 'remove');
            users = users.filter((d) => d !== entry);
            carryMapping(entry.name, null);
            const key = normalizeDirectoryPath(entry.path);
            const at = touched.indexOf(key);
            if (at >= 0) touched.splice(at, 1);
            removed.push({ name: entry.name, path: entry.path });
            break;
          }
        }
      } catch (err) {
        if (err instanceof OpRefused) return { ok: false, index, reason: err.message };
        throw err;
      }
    }

    const directoriesMoved = JSON.stringify(users) !== JSON.stringify(before);
    const mappingsMoved = !sameMappings(mappings, mappingsBefore);
    if (directoriesMoved && !deps.writeUserDirectories(users)) {
      return { ok: false, reason: DIRECTORY_WRITE_FAILED_REASON };
    }
    if (mappingsMoved) {
      deps.writeAreaMappings(mappings);
      deps.mappingsChanged(mappings);
    }
    if (directoriesMoved) deps.directoriesChanged();

    const now = listed(users, hosts);
    return {
      ok: true,
      changed: directoriesMoved || mappingsMoved,
      directories: touched.flatMap((key) => {
        const directory = now.find((d) => normalizeDirectoryPath(d.entry.path) === key);
        return directory ? [describe(directory, mappings, profiles)] : [];
      }),
      removed,
      notes,
    };
  }

  return { listDirectories, editDirectories };
}
