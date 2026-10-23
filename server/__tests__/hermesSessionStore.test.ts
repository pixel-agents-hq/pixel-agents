import { DatabaseSync } from 'node:sqlite';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type HermesSessionStore,
  isHermesPidAlive,
  openHermesStore,
  parseStoredToolCalls,
  readHermesLeases,
} from '../src/providers/hook/hermes/hermesSessionStore.js';

/**
 * The store's own contract tests run against REAL SQLite files in a temp home
 * (never the machine's Hermes directory): DDL is the subset of Hermes' live
 * schema the reader touches, and every expectation pins a format-boundary
 * fact (second→ms conversion, freshest-of, live-row filtering, cursor
 * semantics, defensive JSON parsing).
 */

const DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  last_activity_at REAL,
  last_activity_description TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL
);
`;

let currentTemp: string | null = null;
/** Every store handle this file opens, so cleanup can close them BEFORE
 *  deleting the temp home: on Windows an open SQLite handle pins the
 *  directory and `fs.rmSync` fails with EPERM. */
const openStores: HermesSessionStore[] = [];

function closeStores(): void {
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      /* already dead */
    }
  }
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-store-'));
  currentTemp = home;
  return home;
}

afterEach(() => {
  closeStores();
  if (currentTemp) {
    try {
      fs.rmSync(currentTemp, { recursive: true, force: true });
    } catch {
      /* a handle still pinning the dir must never fail the suite */
    }
    currentTemp = null;
  }
});

function writeDb(home: string): DatabaseSync {
  const db = new DatabaseSync(path.join(home, 'state.db'));
  db.exec(DDL);
  return db;
}

const sec = Math.floor(Date.now() / 1000);

function insertSession(
  db: DatabaseSync,
  overrides: Partial<Record<string, unknown>> & { id: string },
): void {
  const row = {
    source: 'cli',
    cwd: '/work/one',
    title: 'a session',
    parent_session_id: null,
    started_at: sec - 100,
    ended_at: null,
    last_activity_at: null,
    last_activity_description: null,
    hidden: 0,
    archived: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, parent_session_id, started_at, ended_at,
      last_activity_at, last_activity_description, hidden, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.source,
    row.cwd,
    row.title,
    row.parent_session_id,
    row.started_at,
    row.ended_at,
    row.last_activity_at,
    row.last_activity_description,
    row.hidden,
    row.archived,
  );
}

function insertMessage(
  db: DatabaseSync,
  sessionId: string,
  role: string,
  fields: {
    content?: string | null;
    tool_call_id?: string | null;
    tool_calls?: string | null;
    tool_name?: string | null;
    timestamp?: number | null;
  } = {},
): number {
  const result = db
    .prepare(
      `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      role,
      fields.content ?? null,
      fields.tool_call_id ?? null,
      fields.tool_calls ?? null,
      fields.tool_name ?? null,
      fields.timestamp ?? sec - 50,
    );
  return Number(result.lastInsertRowid);
}

function openStore(home: string): HermesSessionStore {
  const store = openHermesStore(home);
  expect(store).not.toBeNull();
  openStores.push(store as HermesSessionStore);
  return store as HermesSessionStore;
}

describe('openHermesStore', () => {
  it('returns null for a home without state.db (never throws)', () => {
    const home = makeHome();
    expect(openHermesStore(home)).toBeNull();
  });

  it('listLiveSessions skips ended, hidden, and archived rows', () => {
    const home = makeHome();
    const db = writeDb(home);
    insertSession(db, { id: 'live-1' });
    insertSession(db, { id: 'ended-1', ended_at: sec - 5 });
    insertSession(db, { id: 'hidden-1', hidden: 1 });
    insertSession(db, { id: 'archived-1', archived: 1 });
    db.close();

    const rows = openStore(home).listLiveSessions();
    expect(rows.map((r) => r.id).sort()).toEqual(['live-1']);
  });

  it('converts unix-second columns to ms and takes the freshest of activity/start', () => {
    const home = makeHome();
    const db = writeDb(home);
    insertSession(db, { id: 's', started_at: sec - 100, last_activity_at: sec - 10 });
    insertSession(db, { id: 'no-activity', started_at: sec - 70 });
    db.close();

    const byId = new Map(
      openStore(home)
        .listLiveSessions()
        .map((r) => [r.id, r]),
    );
    expect(byId.get('s')!.lastActivityMs).toBe((sec - 10) * 1000);
    expect(byId.get('s')!.startedAtMs).toBe((sec - 100) * 1000);
    // Heartbeats rate-limit last_activity_at; never trust it alone.
    expect(byId.get('no-activity')!.lastActivityMs).toBe((sec - 70) * 1000);
  });

  it('carries parent_session_id only when non-empty', () => {
    const home = makeHome();
    const db = writeDb(home);
    insertSession(db, { id: 'parent' });
    insertSession(db, { id: 'kid', parent_session_id: 'parent' });
    insertSession(db, { id: 'blank-parent', parent_session_id: '' });
    db.close();

    const byId = new Map(
      openStore(home)
        .listLiveSessions()
        .map((r) => [r.id, r]),
    );
    expect(byId.get('parent')!.parentSessionId).toBeNull();
    expect(byId.get('kid')!.parentSessionId).toBe('parent');
    expect(byId.get('blank-parent')!.parentSessionId).toBeNull();
  });

  it('endedAtOf: null while live, a number when ended, undefined when the row is gone', () => {
    const home = makeHome();
    const db = writeDb(home);
    insertSession(db, { id: 'alive' });
    insertSession(db, { id: 'gone', ended_at: sec - 5 });
    db.close();

    const store = openStore(home);
    expect(store.endedAtOf('alive')).toBeNull();
    expect(store.endedAtOf('gone')).toBe((sec - 5) * 1000);
    expect(store.endedAtOf('never-existed')).toBeUndefined();
  });

  it('listMessagesAfter replays strictly newer rows, oldest first, honoring the limit', () => {
    const home = makeHome();
    const db = writeDb(home);
    insertSession(db, { id: 's' });
    const id1 = insertMessage(db, 's', 'assistant', { content: 'first' });
    insertMessage(db, 's', 'user', { content: 'second' });
    db.close();

    const store = openStore(home);
    const all = store.listMessagesAfter('s', 0, 10);
    expect(all.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(store.listMessagesAfter('s', id1, 10).map((m) => m.role)).toEqual(['user']);
    expect(store.listMessagesAfter('s', 0, 1)).toHaveLength(1);
    expect(store.latestMessageId('s')).toBe(Math.max(id1, ...all.map((m) => m.id)));
    expect(store.latestMessageId('no-session')).toBe(0);
  });

  it('flags model text and parses tool_calls with arguments projection', () => {
    const home = makeHome();
    const db = writeDb(home);
    insertSession(db, { id: 's' });
    insertMessage(db, 's', 'assistant', {
      content: '',
      tool_calls:
        '[{"id":"c1","function":{"name":"terminal","arguments":"{\\"command\\":\\"ls\\"}"}}]',
    });
    insertMessage(db, 's', 'assistant', { content: 'the answer' });
    insertMessage(db, 's', 'assistant', { tool_calls: 'NOT JSON' });
    db.close();

    const rows = openStore(home).listMessagesAfter('s', 0, 10);
    expect(rows[0].hasText).toBe(false);
    expect(rows[0].toolCalls).toEqual([{ id: 'c1', name: 'terminal', args: { command: 'ls' } }]);
    expect(rows[1].hasText).toBe(true);
    expect(rows[1].toolCalls).toEqual([]);
    // A corrupt call list degrades to "no calls", never an abort.
    expect(rows[2].toolCalls).toEqual([]);
  });

  it('listDirectorySuggestions groups by cwd, coalesces recency, skips blanks', () => {
    const home = makeHome();
    const db = writeDb(home);
    insertSession(db, {
      id: 'a',
      cwd: '/work/one',
      started_at: sec - 100,
      last_activity_at: sec - 90,
    });
    insertSession(db, { id: 'b', cwd: '/work/one', started_at: sec - 20 });
    insertSession(db, { id: 'c', cwd: '/work/two', started_at: sec - 500 });
    insertSession(db, { id: 'd', cwd: null, started_at: sec - 1 });
    insertSession(db, { id: 'e', cwd: '', started_at: sec - 1 });
    db.close();

    const entries = openStore(home).listDirectorySuggestions(10);
    expect(entries.map((e) => e.cwd)).toEqual(['/work/one', '/work/two']);
    expect(entries[0].lastActiveMs).toBe((sec - 20) * 1000);
  });

  it('a corrupt or locked database yields empty reads, not throws', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'state.db'), 'this is not a database');
    const store = openHermesStore(home);
    // node:sqlite may refuse to open at all (null) or open and fail per query
    // ([]); both are "no data" — the office must not care which one happened.
    if (store) {
      openStores.push(store);
      expect(store.listLiveSessions()).toEqual([]);
      expect(store.endedAtOf('x')).toBeUndefined();
      expect(store.listMessagesAfter('x', 0, 5)).toEqual([]);
      expect(store.latestMessageId('x')).toBe(0);
      expect(store.listDirectorySuggestions(5)).toEqual([]);
    } else {
      expect(store).toBeNull();
    }
  });
});

describe('parseStoredToolCalls', () => {
  it('accepts call_id as the id fallback and drops nameless/idless entries', () => {
    const calls = parseStoredToolCalls(
      JSON.stringify([
        { call_id: 'c2', function: { name: 'read_file', arguments: '{}' } },
        { id: '', function: { name: 'x', arguments: '{}' } },
        { id: 'c3', function: { name: '', arguments: '{}' } },
        'string junk',
        null,
      ]),
    );
    expect(calls).toEqual([{ id: 'c2', name: 'read_file', args: {} }]);
  });

  it('tolerates non-object arguments and non-arrays', () => {
    expect(
      parseStoredToolCalls('[{"id":"c","function":{"name":"n","arguments":"[1,2]"}}]'),
    ).toEqual([{ id: 'c', name: 'n' }]);
    expect(parseStoredToolCalls('{"id":"c"}')).toEqual([]);
    expect(parseStoredToolCalls(null)).toEqual([]);
    expect(parseStoredToolCalls('')).toEqual([]);
  });
});

describe('readHermesLeases / isHermesPidAlive', () => {
  it('keeps only unreleased, pid-bearing entries', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'runtime', 'active_sessions.json'),
      JSON.stringify({
        entries: [
          { lease_id: 'l1', session_id: 's1', pid: 4242, surface: 'cli' },
          { lease_id: 'l2', session_id: 's2', pid: 4243, surface: 'desktop', released: true },
          { lease_id: 'l3', session_id: 's3', pid: 0, surface: 'cli' },
          { lease_id: 'l4', session_id: '', pid: 1, surface: 'cli' },
          { lease_id: 'l5', session_id: 's5', pid: 'nope', surface: 'tui' },
        ],
      }),
    );
    expect(readHermesLeases(home)).toEqual([{ sessionId: 's1', pid: 4242, surface: 'cli' }]);
  });

  it('a missing or malformed registry is just empty', () => {
    const home = makeHome();
    expect(readHermesLeases(home)).toEqual([]);
    fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(home, 'runtime', 'active_sessions.json'), '{ truncated');
    expect(readHermesLeases(home)).toEqual([]);
  });

  it('probes this process alive and a huge pid dead', () => {
    expect(isHermesPidAlive(process.pid)).toBe(true);
    expect(isHermesPidAlive(0x0ffffff0)).toBe(false);
  });
});
