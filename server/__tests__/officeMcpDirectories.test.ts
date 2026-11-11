/**
 * list_directories / edit_directories through the Pixel Office MCP's main
 * seam: a composed standalone server over a temp HOME holding one user
 * Directory (config.json), an agent launched from the office, and the MCP
 * SDK's client calling the tools with that agent's token. Asserted on what the
 * agent gets back, what lands in config.json and what every office is sent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { type Json, useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

/** Any Area colour (spelled in parts: colour literals live in constants files). */
const AREA_COLOR = ['#', 'ff6b6b'].join('');

describe('edit_directories (composed server, one user Directory)', () => {
  const h = useStandaloneOffice({
    name: 'pxl-mcp-directories',
    grant: true,
    launch: true,
    layout: 'file',
    prepare: ({ home, workspace }) => {
      for (const sub of ['varys', 'fresh', 'moved']) fs.mkdirSync(path.join(workspace, sub));
      const dir = path.join(home, '.pixel-agents');
      fs.mkdirSync(dir, { recursive: true });
      // A layout with two Areas for a Directory to sit in.
      fs.writeFileSync(
        path.join(dir, 'layout.json'),
        JSON.stringify({
          version: 1,
          cols: 2,
          rows: 2,
          tiles: [1, 1, 1, 1],
          furniture: [],
          areas: [
            { label: 'Lab', color: AREA_COLOR },
            { label: 'Den', color: AREA_COLOR },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          directories: [
            {
              name: 'Varys',
              path: path.join(workspace, 'varys'),
              characters: [2, 0],
              worktreeBranchPrefix: 'pablo/',
            },
          ],
        }),
      );
    },
  });

  const config = (): Json =>
    JSON.parse(fs.readFileSync(path.join(h.home, '.pixel-agents', 'config.json'), 'utf8')) as Json;
  const stored = (name: string): Json | undefined =>
    (config().directories as Json[]).find((d) => d.name === name);
  const mappings = (): Json => config().standalone.areaMappings as Json;
  const at = (sub: string): string => fs.realpathSync(path.join(h.workspace, sub));

  type Client = Parameters<typeof h.callTool>[0];
  const edit = (client: Client, ops: Json[]) => h.callTool(client, 'edit_directories', { ops });
  const list = async (client: Client): Promise<Json[]> =>
    (await h.callTool(client, 'list_directories')).value!.directories as Json[];
  it("lists the user's Directories with their settings, then the folder the office runs in", async () => {
    const { client } = await h.launchAgent();
    const directories = await list(client);
    expect(directories[0]).toEqual({
      name: 'Varys',
      path: path.join(h.workspace, 'varys'),
      source: 'user',
      is_repo: false,
      areas: [],
      characters: [
        { id: 'char-2', name: expect.any(String), palette: 2 },
        { id: 'char-0', name: expect.any(String), palette: 0 },
      ],
      character_order: 'priority',
      worktree_base: 'head',
      worktree_branch_prefix: 'pablo/',
    });
    expect(directories.slice(1).every((d) => d.source === 'host')).toBe(true);
  });

  it('a new project in one op: added with characters and Areas, saved, shown in every office', async () => {
    const { client } = await h.launchAgent();
    const before = h.received.length;
    const reply = await edit(client, [
      {
        op: 'add',
        path: path.join(h.workspace, 'fresh'),
        name: 'Fresh',
        characters: ['char-3', 1],
        character_order: 'random',
        areas: ['lab'],
      },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value).toEqual({
      applied: 1,
      changed: true,
      directories: [
        {
          name: 'Fresh',
          path: at('fresh'),
          source: 'user',
          is_repo: false,
          areas: ['Lab'],
          characters: [
            { id: 'char-3', name: expect.any(String), palette: 3 },
            { id: 'char-1', name: expect.any(String), palette: 1 },
          ],
          character_order: 'random',
          worktree_base: 'head',
          worktree_branch_prefix: '',
        },
      ],
    });

    expect(stored('Fresh')).toEqual({
      name: 'Fresh',
      path: at('fresh'),
      characters: [3, 1],
      characterOrder: 'random',
    });
    // The Directory that was there is untouched.
    expect(stored('Varys')).toMatchObject({ characters: [2, 0], worktreeBranchPrefix: 'pablo/' });
    expect(mappings()).toEqual({ Fresh: ['Lab'] });

    const loaded = await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'directoriesLoaded'),
      'directoriesLoaded',
    );
    expect((loaded.directories as Json[]).map((d) => d.name)).toContain('Fresh');
    const mapped = h.received.slice(before).find((m) => m.type === 'areaMappingsLoaded');
    expect(mapped?.mappings).toEqual({ Fresh: ['Lab'] });

    // launch_agent and the other edit tools know it by name at once.
    const map = await h.callTool(client, 'edit_layout', {
      ops: [{ op: 'map_directory', directory: 'Fresh', area: 'Den' }],
    });
    expect(map.isError, map.text).toBe(false);
    expect((await list(client)).find((d) => d.name === 'Fresh')?.areas).toEqual(['Lab', 'Den']);
  });

  it('update changes only what is given; a rename takes its Area mapping along', async () => {
    const { client } = await h.launchAgent();
    expect(
      (await edit(client, [{ op: 'update', directory: 'varys', areas: ['Den'] }])).isError,
    ).toBe(false);
    expect(mappings()).toEqual({ Varys: ['Den'] });

    const reply = await edit(client, [
      { op: 'update', directory: 'Varys', name: 'Spider', worktree_base: 'fresh' },
      { op: 'update', directory: 'Spider', path: path.join(h.workspace, 'moved') },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value!.directories).toHaveLength(1);
    expect(stored('Varys')).toBeUndefined();
    expect(stored('Spider')).toEqual({
      name: 'Spider',
      path: at('moved'),
      characters: [2, 0],
      worktreeBase: 'fresh',
      worktreeBranchPrefix: 'pablo/',
    });
    expect(mappings()).toEqual({ Spider: ['Den'] });

    // Areas and characters emptied.
    const cleared = await edit(client, [
      { op: 'update', directory: 'Spider', areas: [], characters: [] },
    ]);
    expect(cleared.isError, cleared.text).toBe(false);
    expect(stored('Spider')).toEqual({
      name: 'Spider',
      path: at('moved'),
      worktreeBase: 'fresh',
      worktreeBranchPrefix: 'pablo/',
    });
    expect(mappings()).toEqual({});
  });

  it('remove drops the entry and its mapping, never the folder', async () => {
    const { client } = await h.launchAgent();
    await edit(client, [{ op: 'update', directory: 'Varys', areas: ['Lab'] }]);
    const reply = await edit(client, [
      { op: 'remove', directory: path.join(h.workspace, 'varys') },
    ]);
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value).toEqual({
      applied: 1,
      changed: true,
      removed: [{ name: 'Varys', path: path.join(h.workspace, 'varys') }],
    });
    expect(config().directories).toEqual([]);
    expect(mappings()).toEqual({});
    expect(fs.existsSync(path.join(h.workspace, 'varys'))).toBe(true);
  });

  it('a failing op refuses the whole batch and writes nothing', async () => {
    const { client } = await h.launchAgent();
    const was = JSON.stringify(config().directories);
    const refusals: Array<[Json[], RegExp]> = [
      [
        [
          { op: 'add', path: path.join(h.workspace, 'fresh') },
          { op: 'add', path: path.join(h.workspace, 'nowhere') },
        ],
        /op 1 \(add\): No such directory: .*nowhere\. Nothing was changed\./,
      ],
      [[{ op: 'add', path: path.join(h.workspace, 'varys') }], /already is the Directory "Varys"/],
      [
        [{ op: 'add', path: path.join(h.workspace, 'fresh'), name: 'VARYS' }],
        /another Directory is already called "Varys"/,
      ],
      [[{ op: 'update', directory: 'Nope', name: 'X' }], /no Directory "Nope" \(Directories: /],
      [
        [{ op: 'update', directory: 'Varys', characters: ['Nobody'] }],
        /There is no character called Nobody/,
      ],
      [[{ op: 'update', directory: 'Varys', areas: ['Attic'] }], /no Area "Attic"/],
      [[{ op: 'remove', directory: h.workspace }], /the folder this office runs in/],
    ];
    for (const [ops, reason] of refusals) {
      const reply = await h.callToolCaught(client, 'edit_directories', { ops });
      expect(reply.isError, JSON.stringify(ops)).toBe(true);
      expect(reply.text).toMatch(reason);
      expect(JSON.stringify(config().directories)).toBe(was);
    }
  });

  it("`add` on the office's own folder gives it a name and settings of its own", async () => {
    const { client } = await h.launchAgent();
    const reply = await edit(client, [{ op: 'add', path: h.workspace, name: 'Home base' }]);
    expect(reply.isError, reply.text).toBe(false);
    const directories = await list(client);
    expect(directories.filter((d) => d.path === at('.'))).toEqual([
      expect.objectContaining({ name: 'Home base', source: 'user' }),
    ]);
  });

  it('is refused while the MCP is read-only; listing still works', async () => {
    const { client } = await h.launchAgent();
    const cfg = config();
    fs.writeFileSync(
      path.join(h.home, '.pixel-agents', 'config.json'),
      JSON.stringify({ ...cfg, officeMcpReadOnly: true }),
    );
    const reply = await h.callToolCaught(client, 'edit_directories', {
      ops: [{ op: 'remove', directory: 'Varys' }],
    });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/read-only/);
    expect(await list(client)).not.toHaveLength(0);
  });
});
