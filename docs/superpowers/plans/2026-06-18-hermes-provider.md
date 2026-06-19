# Hermes Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Hermes HookProvider to pixel-agents so sessions started with `hermes chat` appear as animated characters in the pixel-agents office.

**Architecture:** Create a `hermesProvider` following the same `HookProvider` interface used by Claude. Refactor `HookEventHandler` to route events to the correct provider via a `Map<string, HookProvider>` keyed by provider ID. Wire Hermes hook install/uninstall into `PixelAgentsViewProvider` alongside Claude.

**Tech Stack:** TypeScript, Node.js, Vitest, js-yaml (new dep), esbuild

## Global Constraints

- Working directory for all commands: `~/ai/pixel-agents`
- Test runner: `cd server && npm test` (Vitest)
- Build: `npm run compile` from repo root
- TypeScript strict mode — no `any` unless absolutely necessary
- Never use `--no-verify` on commits
- Hermes provider id string: `"hermes"` (lowercase, matches HTTP route `/hook/hermes`)
- Hook script output path: `dist/hooks/hermes-hook.js`
- Hook script install path: `~/.pixel-agents/hooks/hermes-hook.js`
- Hermes config path: `~/.hermes/config.yaml`

---

### Task 1: Add js-yaml dependency

**Files:**

- Modify: `server/package.json`

**Interfaces:**

- Produces: `import yaml from 'js-yaml'` available in server TypeScript files

- [ ] **Step 1: Add js-yaml to server/package.json**

Replace the `dependencies` and add `devDependencies` section in `server/package.json`:

```json
{
  "name": "pixel-agents",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "vitest": "^3.2.1"
  },
  "dependencies": {
    "@fastify/cors": "^11.2.0",
    "@fastify/static": "^9.1.1",
    "@fastify/websocket": "^11.2.0",
    "fastify": "^5.8.5",
    "js-yaml": "^4.1.0"
  }
}
```

- [ ] **Step 2: Install the dependency**

```bash
cd server && npm install
```

Expected: `node_modules/js-yaml` present, `package-lock.json` updated.

- [ ] **Step 3: Verify TypeScript can see the types**

```bash
cd server && npx tsc --noEmit 2>&1 | head -5
```

Expected: no errors about `js-yaml`.

- [ ] **Step 4: Commit**

```bash
cd ~/ai/pixel-agents
git add server/package.json server/package-lock.json
git commit -m "chore: add js-yaml dependency for Hermes config.yaml installer"
```

---

### Task 2: Hermes constants + hook script + esbuild

**Files:**

- Create: `server/src/providers/hook/hermes/constants.ts`
- Create: `server/src/providers/hook/hermes/hooks/hermes-hook.ts`
- Modify: `esbuild.js`

**Interfaces:**

- Produces:
  - `HERMES_HOOK_SCRIPT_NAME = 'hermes-hook.js'`
  - `HERMES_HOOK_EVENTS` array of 5 event name strings
  - `HERMES_TERMINAL_NAME_PREFIX = 'hermes'`
  - `dist/hooks/hermes-hook.js` (bundled CJS script)

- [ ] **Step 1: Create constants.ts**

Create `server/src/providers/hook/hermes/constants.ts`:

```typescript
export const HERMES_HOOK_SCRIPT_NAME = 'hermes-hook.js';

export const HERMES_HOOK_EVENTS = [
  'pre_tool_call',
  'post_tool_call',
  'post_llm_call',
  'on_session_start',
  'on_session_end',
] as const;

export const HERMES_TERMINAL_NAME_PREFIX = 'hermes';
```

- [ ] **Step 2: Create hermes-hook.ts**

Create `server/src/providers/hook/hermes/hooks/hermes-hook.ts`:

```typescript
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { HOOK_API_PREFIX, SERVER_JSON_DIR, SERVER_JSON_NAME } from '../../../../constants.js';
import type { ServerConfig } from '../../../../server.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  let server: ServerConfig;
  try {
    server = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8'));
  } catch {
    process.exit(0);
  }

  const body = JSON.stringify(data);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: `${HOOK_API_PREFIX}/hermes`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${server.token}`,
        },
        timeout: 2000,
      },
      () => resolve(),
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
```

- [ ] **Step 3: Add hermes-hook to esbuild.js**

In `esbuild.js`, find the `buildHooks()` function and replace it with one that bundles both scripts:

```javascript
function buildHooks() {
  const entries = [
    path.join(__dirname, 'server', 'src', 'providers', 'hook', 'claude', 'hooks', 'claude-hook.ts'),
    path.join(__dirname, 'server', 'src', 'providers', 'hook', 'hermes', 'hooks', 'hermes-hook.ts'),
  ].filter((e) => fs.existsSync(e));

  if (entries.length === 0) return;

  require('esbuild').buildSync({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: path.join(__dirname, 'dist', 'hooks'),
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log('✓ Built hooks/ → dist/hooks/');
}
```

- [ ] **Step 4: Build and verify hook script is produced**

```bash
npm run compile
ls dist/hooks/
```

Expected output includes both `claude-hook.js` and `hermes-hook.js`.

- [ ] **Step 5: Commit**

```bash
git add server/src/providers/hook/hermes/constants.ts \
        server/src/providers/hook/hermes/hooks/hermes-hook.ts \
        esbuild.js
git commit -m "feat: add Hermes hook script and constants"
```

---

### Task 3: Hermes hook installer (TDD)

**Files:**

- Create: `server/src/providers/hook/hermes/hermesHookInstaller.ts`
- Create: `server/__tests__/hermesHookInstaller.test.ts`

**Interfaces:**

- Consumes: `HERMES_HOOK_SCRIPT_NAME`, `HERMES_HOOK_EVENTS` from `./constants.js`
- Produces:
  - `installHooks(serverUrl: string, authToken: string): Promise<void>`
  - `uninstallHooks(): Promise<void>`
  - `areHooksInstalled(): Promise<boolean>`
  - `copyHookScript(extensionPath: string): void`

- [ ] **Step 1: Write the failing tests**

Create `server/__tests__/hermesHookInstaller.test.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks } =
  await import('../src/providers/hook/hermes/hermesHookInstaller.js');

const CONFIG_PATH = () => path.join(tmpBase, '.hermes', 'config.yaml');

function readConfig(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(CONFIG_PATH(), 'utf-8')) as Record<string, unknown>;
}

describe('hermesHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-test-'));
    fs.mkdirSync(path.join(tmpBase, '.hermes'), { recursive: true });
    // Minimal config.yaml
    fs.writeFileSync(CONFIG_PATH(), 'hooks: {}\n', 'utf-8');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('installHooks adds entries for all 5 events', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    const cfg = readConfig();
    const hooks = cfg.hooks as Record<string, unknown[]>;
    expect(hooks['pre_tool_call']).toHaveLength(1);
    expect(hooks['post_tool_call']).toHaveLength(1);
    expect(hooks['post_llm_call']).toHaveLength(1);
    expect(hooks['on_session_start']).toHaveLength(1);
    expect(hooks['on_session_end']).toHaveLength(1);
  });

  it('installHooks is idempotent', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    await installHooks('http://127.0.0.1:3100', 'token');
    const hooks = readConfig().hooks as Record<string, unknown[]>;
    expect(hooks['pre_tool_call']).toHaveLength(1);
  });

  it('areHooksInstalled returns true after install', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    expect(await areHooksInstalled()).toBe(true);
  });

  it('areHooksInstalled returns false when config has empty hooks', async () => {
    expect(await areHooksInstalled()).toBe(false);
  });

  it('areHooksInstalled returns false when config.yaml is missing', async () => {
    fs.unlinkSync(CONFIG_PATH());
    expect(await areHooksInstalled()).toBe(false);
  });

  it('uninstallHooks removes pixel-agents entries', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    expect(await areHooksInstalled()).toBe(true);
    await uninstallHooks();
    expect(await areHooksInstalled()).toBe(false);
  });

  it('uninstallHooks preserves other user hook entries', async () => {
    // Pre-existing user hook
    fs.writeFileSync(
      CONFIG_PATH(),
      yaml.dump({
        hooks: {
          pre_tool_call: [{ command: 'echo user-hook', timeout: 5 }],
        },
      }),
      'utf-8',
    );
    await installHooks('http://127.0.0.1:3100', 'token');
    await uninstallHooks();
    const hooks = readConfig().hooks as Record<string, unknown[]>;
    expect(hooks['pre_tool_call']).toHaveLength(1);
    expect((hooks['pre_tool_call'][0] as Record<string, unknown>).command).toBe('echo user-hook');
  });

  it('installHooks creates config.yaml if missing', async () => {
    fs.unlinkSync(CONFIG_PATH());
    await installHooks('http://127.0.0.1:3100', 'token');
    expect(fs.existsSync(CONFIG_PATH())).toBe(true);
    expect(await areHooksInstalled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd ~/ai/pixel-agents/server && npm test -- hermesHookInstaller
```

Expected: all 7 tests fail with `Cannot find module '../src/providers/hook/hermes/hermesHookInstaller.js'`.

- [ ] **Step 3: Implement hermesHookInstaller.ts**

Create `server/src/providers/hook/hermes/hermesHookInstaller.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import yaml from 'js-yaml';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { HERMES_HOOK_EVENTS, HERMES_HOOK_SCRIPT_NAME } from './constants.js';

function getHermesConfigPath(): string {
  return path.join(os.homedir(), '.hermes', 'config.yaml');
}

function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, HERMES_HOOK_SCRIPT_NAME);
}

function makeHookCommand(): string {
  return `node "${getHookScriptPath()}"`;
}

function isOurEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const cmd = (entry as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd.includes(HERMES_HOOK_SCRIPT_NAME);
}

function readConfig(): Record<string, unknown> {
  const p = getHermesConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return (yaml.load(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>) ?? {};
  } catch {
    throw new Error(
      `[Pixel Agents] ~/.hermes/config.yaml is malformed — fix it before installing hooks`,
    );
  }
}

function writeConfig(cfg: Record<string, unknown>): void {
  const p = getHermesConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.pixel-agents-tmp';
  fs.writeFileSync(tmp, yaml.dump(cfg), 'utf-8');
  fs.renameSync(tmp, p);
}

export async function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  const cfg = readConfig();
  const hooks =
    cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks)
      ? (cfg.hooks as Record<string, unknown[]>)
      : {};

  const command = makeHookCommand();
  let changed = false;

  for (const event of HERMES_HOOK_EVENTS) {
    const entries: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const withoutOurs = entries.filter((e) => !isOurEntry(e));
    const newEntry = { command, timeout: 10 };
    hooks[event] = [...withoutOurs, newEntry];
    changed = true;
  }

  if (changed) {
    writeConfig({ ...cfg, hooks });
    console.log('[Pixel Agents] Hermes hooks installed in ~/.hermes/config.yaml');
  }
}

export async function uninstallHooks(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) return;

  const hooks = cfg.hooks as Record<string, unknown[]>;
  let changed = false;

  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((e) => !isOurEntry(e));
    if (filtered.length !== entries.length) {
      hooks[event] = filtered;
      changed = true;
    }
    if (hooks[event].length === 0) delete hooks[event];
  }

  if (changed) {
    writeConfig({ ...cfg, hooks });
    console.log('[Pixel Agents] Hermes hooks removed from ~/.hermes/config.yaml');
  }
}

export async function areHooksInstalled(): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) return false;
  const hooks = cfg.hooks as Record<string, unknown[]>;
  return HERMES_HOOK_EVENTS.some(
    (event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(isOurEntry),
  );
}

export function copyHookScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', HERMES_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);
  try {
    if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Hermes hook script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Hermes hook script installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy Hermes hook script: ${e}`);
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd ~/ai/pixel-agents/server && npm test -- hermesHookInstaller
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/ai/pixel-agents
git add server/src/providers/hook/hermes/hermesHookInstaller.ts \
        server/__tests__/hermesHookInstaller.test.ts
git commit -m "feat: add Hermes hook installer (config.yaml)"
```

---

### Task 4: Hermes HookProvider + provider registry (TDD)

**Files:**

- Create: `server/src/providers/hook/hermes/hermes.ts`
- Create: `server/__tests__/hermes.test.ts`
- Modify: `server/src/providers/index.ts`

**Interfaces:**

- Consumes: `HookProvider` from `../../../../../core/src/provider.js`
- Consumes: `installHooks`, `uninstallHooks`, `areHooksInstalled`, `copyHookScript` from `./hermesHookInstaller.js`
- Consumes: `HERMES_HOOK_SCRIPT_NAME`, `HERMES_TERMINAL_NAME_PREFIX` from `./constants.js`
- Produces: `hermesProvider` exported from `providers/index.ts` with `id = 'hermes'`

- [ ] **Step 1: Write the failing tests**

Create `server/__tests__/hermes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

describe('hermesProvider.normalizeHookEvent', () => {
  const normalize = (raw: Record<string, unknown>) => hermesProvider.normalizeHookEvent(raw);

  it('returns null for unknown events', () => {
    expect(normalize({ hook_event_name: 'unknown_event', session_id: 'abc' })).toBeNull();
  });

  it('maps on_session_start to sessionStart', () => {
    const result = normalize({
      hook_event_name: 'on_session_start',
      session_id: 'sess-123',
      model: 'claude-sonnet-4-6',
    });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-123');
    expect(result!.event.kind).toBe('sessionStart');
    expect((result!.event as { source?: string }).source).toBe('claude-sonnet-4-6');
  });

  it('maps pre_tool_call to toolStart', () => {
    const result = normalize({
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-123',
      tool_name: 'terminal',
      tool_call_id: 'call-abc',
      args: { command: 'echo hello' },
    });
    expect(result).not.toBeNull();
    expect(result!.event.kind).toBe('toolStart');
    const ev = result!.event as { kind: string; toolId: string; toolName: string; input?: unknown };
    expect(ev.toolId).toBe('call-abc');
    expect(ev.toolName).toBe('terminal');
    expect(ev.input).toEqual({ command: 'echo hello' });
  });

  it('returns null for pre_tool_call missing tool_call_id', () => {
    expect(
      normalize({
        hook_event_name: 'pre_tool_call',
        session_id: 'sess-123',
        tool_name: 'terminal',
      }),
    ).toBeNull();
  });

  it('maps post_tool_call to toolEnd', () => {
    const result = normalize({
      hook_event_name: 'post_tool_call',
      session_id: 'sess-123',
      tool_call_id: 'call-abc',
    });
    expect(result!.event.kind).toBe('toolEnd');
    expect((result!.event as { toolId: string }).toolId).toBe('call-abc');
  });

  it('maps post_llm_call to turnEnd', () => {
    const result = normalize({
      hook_event_name: 'post_llm_call',
      session_id: 'sess-123',
    });
    expect(result!.event.kind).toBe('turnEnd');
  });

  it('maps on_session_end to sessionEnd', () => {
    const result = normalize({
      hook_event_name: 'on_session_end',
      session_id: 'sess-123',
    });
    expect(result!.event.kind).toBe('sessionEnd');
  });

  it('ignores subagent_stop', () => {
    expect(
      normalize({
        hook_event_name: 'subagent_stop',
        session_id: 'sess-123',
      }),
    ).toBeNull();
  });
});

describe('hermesProvider.formatToolStatus', () => {
  const fmt = (tool: string, input?: unknown) => hermesProvider.formatToolStatus(tool, input);

  it('formats terminal with command', () => {
    expect(fmt('terminal', { command: 'npm test' })).toBe('Running: npm test');
  });

  it('formats read_file with filename', () => {
    expect(fmt('read_file', { path: '/some/dir/foo.ts' })).toBe('Reading foo.ts');
  });

  it('formats write_file with filename', () => {
    expect(fmt('write_file', { path: '/some/dir/bar.ts' })).toBe('Writing bar.ts');
  });

  it('formats patch with filename', () => {
    expect(fmt('patch', { path: '/some/dir/baz.ts' })).toBe('Editing baz.ts');
  });

  it('formats search_files as generic', () => {
    expect(fmt('search_files')).toBe('Searching files');
  });

  it('formats browser as web fetch', () => {
    expect(fmt('browser')).toBe('Fetching web content');
  });

  it('formats process generically', () => {
    expect(fmt('process')).toBe('Running process');
  });

  it('formats unknown tools with Using prefix', () => {
    expect(fmt('some_unknown_tool')).toBe('Using some_unknown_tool');
  });
});

describe('hermesProvider metadata', () => {
  it('has id hermes', () => {
    expect(hermesProvider.id).toBe('hermes');
  });

  it('has kind hook', () => {
    expect(hermesProvider.kind).toBe('hook');
  });

  it('readingTools includes read_file, search_files, browser', () => {
    expect(hermesProvider.readingTools.has('read_file')).toBe(true);
    expect(hermesProvider.readingTools.has('search_files')).toBe(true);
    expect(hermesProvider.readingTools.has('browser')).toBe(true);
  });

  it('permissionExemptTools includes read_file', () => {
    expect(hermesProvider.permissionExemptTools.has('read_file')).toBe(true);
  });

  it('terminalNamePrefix is hermes', () => {
    expect(hermesProvider.terminalNamePrefix).toBe('hermes');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd ~/ai/pixel-agents/server && npm test -- hermes.test
```

Expected: all tests fail with `Cannot find module '../src/providers/hook/hermes/hermes.js'`.

- [ ] **Step 3: Implement hermes.ts**

Create `server/src/providers/hook/hermes/hermes.ts`:

```typescript
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  areHooksInstalled,
  copyHookScript,
  installHooks,
  uninstallHooks,
} from './hermesHookInstaller.js';
import { HERMES_TERMINAL_NAME_PREFIX } from './constants.js';

function base(p: unknown): string {
  return typeof p === 'string' ? path.basename(p) : '';
}

function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'terminal': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd}`;
    }
    case 'read_file':
      return `Reading ${base(inp.path)}`;
    case 'write_file':
      return `Writing ${base(inp.path)}`;
    case 'patch':
      return `Editing ${base(inp.path)}`;
    case 'search_files':
      return 'Searching files';
    case 'browser':
      return 'Fetching web content';
    case 'process':
      return 'Running process';
    default:
      return `Using ${toolName}`;
  }
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId = raw.session_id as string;
  if (!sessionId) return null;

  switch (raw.hook_event_name) {
    case 'on_session_start':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.model === 'string' ? raw.model : undefined,
        },
      };

    case 'pre_tool_call': {
      const toolId = raw.tool_call_id as string | undefined;
      if (!toolId) return null;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName: (raw.tool_name as string) ?? 'unknown',
          input: raw.args,
        },
      };
    }

    case 'post_tool_call': {
      const toolId = raw.tool_call_id as string | undefined;
      if (!toolId) return null;
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId },
      };
    }

    case 'post_llm_call':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'on_session_end':
      return { sessionId, event: { kind: 'sessionEnd' } };

    default:
      return null;
  }
}

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes',
  protocolVersion: 1,

  normalizeHookEvent,
  formatToolStatus,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  permissionExemptTools: new Set(['read_file', 'search_files', 'process']),
  subagentToolNames: new Set(),
  readingTools: new Set(['read_file', 'search_files', 'browser']),
  terminalNamePrefix: HERMES_TERMINAL_NAME_PREFIX,
};
```

- [ ] **Step 4: Export hermesProvider from providers/index.ts**

Open `server/src/providers/index.ts` and add the Hermes export:

```typescript
export { claudeProvider } from './hook/claude/claude.js';
export { copyHookScript } from './hook/claude/claudeHookInstaller.js';
export { hermesProvider } from './hook/hermes/hermes.js';
export { copyHookScript as copyHermesHookScript } from './hook/hermes/hermesHookInstaller.js';
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd ~/ai/pixel-agents/server && npm test -- hermes.test
```

Expected: all tests pass.

- [ ] **Step 6: Run the full test suite to check for regressions**

```bash
cd ~/ai/pixel-agents/server && npm test
```

Expected: all pre-existing tests still pass.

- [ ] **Step 7: Commit**

```bash
cd ~/ai/pixel-agents
git add server/src/providers/hook/hermes/hermes.ts \
        server/__tests__/hermes.test.ts \
        server/src/providers/index.ts
git commit -m "feat: add Hermes HookProvider and register in providers index"
```

---

### Task 5: Refactor HookEventHandler to support multiple providers

**Files:**

- Modify: `server/src/hookEventHandler.ts`
- Modify: `server/__tests__/hookEventHandler.test.ts`

**Interfaces:**

- Consumes: `HookProvider[]` or `Map<string, HookProvider>` — constructor changes
- Produces: `new HookEventHandler(agents, waitingTimers, permissionTimers, providers, sessionRouter, watchRef)` where `providers` is `Map<string, HookProvider>`

**Strategy:** Add a `providers: Map<string, HookProvider>` field alongside the existing `provider`. In `handleEvent`, look up the correct provider by `_providerId`; fall back to `this.provider` for unknown IDs (preserves 100% backward compat for Claude).

- [ ] **Step 1: Add providers Map to HookEventHandler constructor**

In `server/src/hookEventHandler.ts`, find the constructor:

```typescript
constructor(
  private agents: AgentStateStore,
  private waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  private permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  private provider: HookProvider,
  private sessionRouter: SessionRouter,
  private watchAllSessionsRef?: { current: boolean },
)
```

Replace with:

```typescript
constructor(
  private agents: AgentStateStore,
  private waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  private permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  private provider: HookProvider,
  private sessionRouter: SessionRouter,
  private watchAllSessionsRef?: { current: boolean },
  private extraProviders: Map<string, HookProvider> = new Map(),
) {
```

(Keep everything else in the constructor body unchanged.)

- [ ] **Step 2: Add a private getProvider helper**

Directly after the constructor closing brace, add:

```typescript
private getProvider(providerId: string): HookProvider {
  return this.extraProviders.get(providerId) ?? this.provider;
}
```

- [ ] **Step 3: Update handleEvent to use getProvider**

In `handleEvent(_providerId: string, event: HookEvent)`, find these lines near the top of the method:

```typescript
handleEvent(_providerId: string, event: HookEvent): void {
  if (this.provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
    return; // version mismatch already logged in constructor
  }
  // ...
  const normalized = this.provider.normalizeHookEvent(event);
```

Replace with:

```typescript
handleEvent(providerId: string, event: HookEvent): void {
  const provider = this.getProvider(providerId);
  if (provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
    return;
  }
  // ...
  const normalized = provider.normalizeHookEvent(event);
```

Also find the remaining usages of `this.provider` inside `handleEvent` (for `permissionExemptTools`, `formatToolStatus`, `getSubagentToolSet`, etc.) and replace each with `provider` (the local variable). Search for `this.provider` in the method body — there should be roughly 5-8 usages. Each `this.provider.xxx` becomes `provider.xxx`.

- [ ] **Step 4: Update getSubagentToolSet to accept a provider parameter**

Find `getSubagentToolSet()`:

```typescript
private getSubagentToolSet(): ReadonlySet<string> {
  if (this.provider.team) {
    return new Set<string>([
      ...this.provider.team.teammateSpawnTools,
      ...this.provider.team.withinTurnSubagentTools,
    ]);
  }
  return this.provider.subagentToolNames;
}
```

Replace with:

```typescript
private getSubagentToolSet(provider: HookProvider): ReadonlySet<string> {
  if (provider.team) {
    return new Set<string>([
      ...provider.team.teammateSpawnTools,
      ...provider.team.withinTurnSubagentTools,
    ]);
  }
  return provider.subagentToolNames;
}
```

Update any call sites of `this.getSubagentToolSet()` in `handleEvent` to `this.getSubagentToolSet(provider)`.

- [ ] **Step 5: Run tests to check nothing is broken**

```bash
cd ~/ai/pixel-agents/server && npm test -- hookEventHandler
```

Expected: all pre-existing hookEventHandler tests pass.

- [ ] **Step 6: Update hookEventHandler.test.ts to also test Hermes routing**

In `server/__tests__/hookEventHandler.test.ts`, after the existing `beforeEach`, add a new `describe` block:

```typescript
describe('HookEventHandler — Hermes provider routing', () => {
  let agents: AgentStateStore;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    waitingTimers = new Map();
    permissionTimers = new Map();
    agents.on('broadcast', () => {});
    const extraProviders = new Map([[hermesProvider.id, hermesProvider]]);
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
      undefined,
      extraProviders,
    );
  });

  it('routes Hermes on_session_start without crashing', () => {
    const agent = createTestAgent({ sessionId: 'hermes-sess-1' });
    agents.set(1, agent);
    handler.registerAgent('hermes-sess-1', 1);

    expect(() =>
      handler.handleEvent('hermes', {
        hook_event_name: 'on_session_start',
        session_id: 'hermes-sess-1',
        model: 'claude-sonnet-4-6',
      }),
    ).not.toThrow();
  });

  it('routes Hermes pre_tool_call to toolStart without crashing', () => {
    const agent = createTestAgent({ sessionId: 'hermes-sess-2' });
    agents.set(2, agent);
    handler.registerAgent('hermes-sess-2', 2);

    expect(() =>
      handler.handleEvent('hermes', {
        hook_event_name: 'pre_tool_call',
        session_id: 'hermes-sess-2',
        tool_name: 'terminal',
        tool_call_id: 'call-xyz',
        args: { command: 'ls' },
      }),
    ).not.toThrow();
  });
});
```

Also add the hermesProvider import at the top of the test file:

```typescript
import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';
```

- [ ] **Step 7: Run all tests**

```bash
cd ~/ai/pixel-agents/server && npm test
```

Expected: all tests pass including the two new Hermes routing tests.

- [ ] **Step 8: Commit**

```bash
cd ~/ai/pixel-agents
git add server/src/hookEventHandler.ts \
        server/__tests__/hookEventHandler.test.ts
git commit -m "refactor: HookEventHandler supports multiple providers via Map"
```

---

### Task 6: Wire Hermes into AgentRuntime + PixelAgentsViewProvider

**Files:**

- Modify: `server/src/agentRuntime.ts`
- Modify: `adapters/vscode/PixelAgentsViewProvider.ts`

**Interfaces:**

- Consumes: `hermesProvider`, `copyHermesHookScript` from `providers/index.js`
- Produces: `new AgentRuntime(store, [claudeProvider, hermesProvider])` works; Hermes hook events reach `hermesProvider.normalizeHookEvent`

- [ ] **Step 1: Update AgentRuntime constructor to accept HookProvider[]**

In `server/src/agentRuntime.ts`, change the constructor signature from:

```typescript
constructor(
  private readonly store: AgentStateStore,
  provider: HookProvider,
) {
  setDismissalTracker(this.dismissalTracker);
  setHookProvider(provider);
  setFileWatcherHookProvider(provider);
  if (provider.team) {
    setTeamProvider(provider.team);
  }
  setAgentRemovalCallback((id) => this.removeAgent(id));
  setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));

  this.hookEventHandler = new HookEventHandler(
    store,
    this.waitingTimers,
    this.permissionTimers,
    provider,
    new SessionRouter(),
    this.watchAllSessions,
  );
```

To:

```typescript
constructor(
  private readonly store: AgentStateStore,
  providers: HookProvider | HookProvider[],
) {
  const providerList = Array.isArray(providers) ? providers : [providers];
  const primary = providerList[0];
  const extraProviders = new Map(
    providerList.slice(1).map((p) => [p.id, p] as [string, HookProvider]),
  );

  setDismissalTracker(this.dismissalTracker);
  setHookProvider(primary);
  setFileWatcherHookProvider(primary);
  if (primary.team) {
    setTeamProvider(primary.team);
  }
  setAgentRemovalCallback((id) => this.removeAgent(id));
  setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));

  this.hookEventHandler = new HookEventHandler(
    store,
    this.waitingTimers,
    this.permissionTimers,
    primary,
    new SessionRouter(),
    this.watchAllSessions,
    extraProviders,
  );
```

- [ ] **Step 2: Run server tests to confirm AgentRuntime change is safe**

```bash
cd ~/ai/pixel-agents/server && npm test
```

Expected: all tests pass (the change is backward-compatible — single provider still works).

- [ ] **Step 3: Update PixelAgentsViewProvider imports**

In `adapters/vscode/PixelAgentsViewProvider.ts`, find the provider import line:

```typescript
import { claudeProvider, copyHookScript } from '../../server/src/providers/index.js';
```

Replace with:

```typescript
import {
  claudeProvider,
  copyHookScript,
  hermesProvider,
  copyHermesHookScript,
} from '../../server/src/providers/index.js';
```

- [ ] **Step 4: Pass both providers to AgentRuntime**

In `PixelAgentsViewProvider.ts`, find:

```typescript
this.runtime = new AgentRuntime(this.store, claudeProvider);
```

Replace with:

```typescript
this.runtime = new AgentRuntime(this.store, [claudeProvider, hermesProvider]);
```

- [ ] **Step 5: Install Hermes hooks on server start**

Find the `initServer` method's `then` block:

```typescript
if (hooksEnabled) {
  void claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
  copyHookScript(this.context.extensionPath);
}
```

Replace with:

```typescript
if (hooksEnabled) {
  void claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
  copyHookScript(this.context.extensionPath);
  void hermesProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
  copyHermesHookScript(this.context.extensionPath);
}
```

- [ ] **Step 6: Handle Hermes hooks in the setHooksEnabled toggle**

Find the `setHooksEnabled` message handler:

```typescript
if (enabled) {
  const serverConfig = this.pixelAgentsServer?.getConfig();
  void claudeProvider.installHooks(
    serverConfig ? `http://127.0.0.1:${serverConfig.port}` : '',
    serverConfig?.token ?? '',
  );
  copyHookScript(this.context.extensionPath);
  console.log('[Pixel Agents] Hooks enabled by user');
} else {
  void claudeProvider.uninstallHooks();
  console.log('[Pixel Agents] Hooks disabled by user');
}
```

Replace with:

```typescript
if (enabled) {
  const serverConfig = this.pixelAgentsServer?.getConfig();
  const url = serverConfig ? `http://127.0.0.1:${serverConfig.port}` : '';
  const token = serverConfig?.token ?? '';
  void claudeProvider.installHooks(url, token);
  copyHookScript(this.context.extensionPath);
  void hermesProvider.installHooks(url, token);
  copyHermesHookScript(this.context.extensionPath);
  console.log('[Pixel Agents] Hooks enabled by user');
} else {
  void claudeProvider.uninstallHooks();
  void hermesProvider.uninstallHooks();
  console.log('[Pixel Agents] Hooks disabled by user');
}
```

- [ ] **Step 7: Union readingTools and subagentToolNames**

Find the `providerCapabilities` message in the `webviewReady` handler:

```typescript
this.webview?.postMessage({
  type: 'providerCapabilities',
  readingTools: [...claudeProvider.readingTools],
  subagentToolNames: [...claudeProvider.subagentToolNames],
});
```

Replace with:

```typescript
this.webview?.postMessage({
  type: 'providerCapabilities',
  readingTools: [...new Set([...claudeProvider.readingTools, ...hermesProvider.readingTools])],
  subagentToolNames: [
    ...new Set([...claudeProvider.subagentToolNames, ...hermesProvider.subagentToolNames]),
  ],
});
```

- [ ] **Step 8: Build the full project**

```bash
cd ~/ai/pixel-agents && npm run compile
```

Expected: builds without TypeScript errors. Both `dist/hooks/claude-hook.js` and `dist/hooks/hermes-hook.js` present in dist.

- [ ] **Step 9: Commit**

```bash
cd ~/ai/pixel-agents
git add server/src/agentRuntime.ts \
        adapters/vscode/PixelAgentsViewProvider.ts
git commit -m "feat: wire Hermes provider into AgentRuntime and PixelAgentsViewProvider"
```

---

### Task 7: End-to-end smoke test

**Goal:** Confirm a live Hermes session appears in pixel-agents.

- [ ] **Step 1: Rebuild and reload VS Code extension**

```bash
cd ~/ai/pixel-agents && npm run compile
```

In VS Code: open Command Palette → "Developer: Reload Window" (or press `Cmd+Shift+P` then type reload).

- [ ] **Step 2: Verify hooks are installed in Hermes config**

```bash
grep -A 3 "hermes-hook" ~/.hermes/config.yaml
```

Expected: entries for `pre_tool_call`, `post_tool_call`, `post_llm_call`, `on_session_start`, `on_session_end` each with `command: node "~/.pixel-agents/hooks/hermes-hook.js"`.

- [ ] **Step 3: Verify hook script is present**

```bash
ls -la ~/.pixel-agents/hooks/hermes-hook.js
```

Expected: file exists and is executable.

- [ ] **Step 4: Start a Hermes session**

Open any terminal (VS Code integrated or external) and run:

```bash
hermes chat --accept-hooks
```

The `--accept-hooks` flag approves the pixel-agents hook on first run.

- [ ] **Step 5: Verify character appears in pixel-agents office**

In VS Code, open the pixel-agents panel. A character should appear when Hermes fires the first `on_session_start` hook. As Hermes uses tools, the character should animate (typing for `terminal`, reading for `read_file`, etc.).

- [ ] **Step 6: Commit final memory note**

```bash
cd ~/ai/pixel-agents
git tag hermes-provider-v1
```

---

## Summary

| Task | Files                                                              | Tests               |
| ---- | ------------------------------------------------------------------ | ------------------- |
| 1    | `server/package.json`                                              | —                   |
| 2    | `hermes/constants.ts`, `hermes/hooks/hermes-hook.ts`, `esbuild.js` | build check         |
| 3    | `hermesHookInstaller.ts`                                           | 7 unit tests        |
| 4    | `hermes.ts`, `providers/index.ts`                                  | 16 unit tests       |
| 5    | `hookEventHandler.ts`                                              | 2 new routing tests |
| 6    | `agentRuntime.ts`, `PixelAgentsViewProvider.ts`                    | full compile check  |
| 7    | —                                                                  | live smoke test     |
