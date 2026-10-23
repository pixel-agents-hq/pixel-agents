import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type AlertFetch, parseAlertsConfig } from '../src/alerts.js';
import {
  ALERTS_CHECK_INTERVAL_MS,
  ALERTS_POST_TIMEOUT_MS,
  DEFAULT_ALERTS_WAIT_MINUTES,
  DEFAULT_NTFY_SERVER,
} from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

/**
 * Phone alerts: once an agent has waited on the user for `waitMinutes`, the
 * server POSTs one ntfy notification for that wait. Config lives in
 * ~/.pixel-agents/alerts.json (here: a temp file); fetch and the clock are
 * injected, so nothing leaves the machine.
 */

const MIN = 60_000;
const TOPIC = 'pixel-agents-Xy12_ab';

interface Sent {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

describe('parseAlertsConfig', () => {
  it('fills in the default server and wait', () => {
    expect(parseAlertsConfig({ ntfyTopic: TOPIC })).toEqual({
      config: {
        topic: TOPIC,
        server: DEFAULT_NTFY_SERVER,
        waitMinutes: DEFAULT_ALERTS_WAIT_MINUTES,
      },
    });
    expect(DEFAULT_NTFY_SERVER).toBe('https://ntfy.sh');
    expect(DEFAULT_ALERTS_WAIT_MINUTES).toBe(15);
  });

  it('takes a custom server (without its trailing slash) and wait', () => {
    expect(
      parseAlertsConfig({ ntfyTopic: TOPIC, ntfyServer: 'http://ntfy.lan:8080/', waitMinutes: 5 }),
    ).toEqual({ config: { topic: TOPIC, server: 'http://ntfy.lan:8080', waitMinutes: 5 } });
  });

  it('refuses a topic that is short, long or not a plain token', () => {
    for (const ntfyTopic of [
      'short',
      'x'.repeat(65),
      'has space1',
      'slash/topic',
      'a?b=cdefgh',
      42,
    ]) {
      expect(parseAlertsConfig({ ntfyTopic })).toHaveProperty('reason');
    }
    expect(parseAlertsConfig({})).toHaveProperty('reason');
  });

  it('refuses a server that is not a plain http(s) URL', () => {
    for (const ntfyServer of ['ntfy.sh', 'ftp://ntfy.sh', 'https://user:pw@ntfy.sh', 7]) {
      expect(parseAlertsConfig({ ntfyTopic: TOPIC, ntfyServer })).toHaveProperty('reason');
    }
  });

  it('refuses a wait that is not a positive number of minutes', () => {
    for (const waitMinutes of [0, -1, '15', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseAlertsConfig({ ntfyTopic: TOPIC, waitMinutes })).toHaveProperty('reason');
    }
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, 'topic', [TOPIC], 3]) {
      expect(parseAlertsConfig(raw)).toHaveProperty('reason');
    }
  });
});

describe('PhoneAlerts (through AgentRuntime)', () => {
  let dir: string;
  let configFile: string;
  let clock: number;
  let sent: Sent[];
  let fetchImpl: AlertFetch;
  let store: AgentStateStore;
  let runtime: AgentRuntime;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-alerts-'));
    configFile = path.join(dir, 'alerts.json');
    clock = new Date(2026, 9, 17, 10, 0, 0).getTime();
    sent = [];
    fetchImpl = async (url, init) => {
      sent.push({ url, ...init });
      return { ok: true, status: 200 };
    };
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, {
      progress: { dailyDir: null, now: () => clock },
      alerts: {
        configFile,
        fetch: (url, init) => fetchImpl(url, init),
        now: () => clock,
      },
    });
  });

  afterEach(() => {
    runtime.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let configVersion = 0;
  function writeConfig(config: unknown): void {
    fs.writeFileSync(configFile, typeof config === 'string' ? config : JSON.stringify(config));
    // A distinct mtime per write, so a rewrite within one clock tick is still seen.
    const t = Date.now() / 1000 + ++configVersion * 10;
    fs.utimesSync(configFile, t, t);
  }

  function addAgent(id: number, extra: Partial<AgentState> = {}): AgentState {
    const agent = createAgentState({
      id,
      sessionId: `session-${id}`,
      isExternal: true,
      projectDir: '/home/me/.claude/projects/secret-dir',
      jsonlFile: '/home/me/.claude/projects/secret-dir/session.jsonl',
      directoryName: 'hobbyfi-blog',
      ...extra,
    });
    store.set(id, agent);
    return agent;
  }

  function status(id: number, value: 'active' | 'waiting'): void {
    store.broadcast({ type: 'agentStatus', id, status: value });
  }

  const check = () => runtime.alerts.check();

  it('alerts once when an agent has waited waitMinutes, with title and repo only', async () => {
    writeConfig({ ntfyTopic: TOPIC });
    const agent = addAgent(1, { title: 'Draft review by email' });
    agent.activeToolStatuses.set('t1', 'Running: rm -rf ~/private');
    status(1, 'waiting');

    clock += 14 * MIN;
    await check();
    expect(sent).toEqual([]);

    clock += MIN;
    await check();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `https://ntfy.sh/${TOPIC}`,
      method: 'POST',
      body: '⏳ Draft review by email · hobbyfi-blog is waiting on you (15m)',
      headers: { Title: 'Claude session waiting', Tags: 'hourglass' },
    });
    expect(sent[0].signal).toBeInstanceOf(AbortSignal);
    expect(sent[0].body).not.toMatch(/rm -rf|private|secret|\.jsonl|\//);

    clock += 10 * MIN;
    await check();
    expect(sent).toHaveLength(1);
  });

  it('uses the repo alone without a title, and the minutes actually waited', async () => {
    writeConfig({ ntfyTopic: TOPIC });
    addAgent(1);
    status(1, 'waiting');

    clock += 17 * MIN + 30_000;
    await check();

    expect(sent.map((s) => s.body)).toEqual(['⏳ hobbyfi-blog is waiting on you (17m)']);
  });

  it('alerts again for a new wait, not for a repeated waiting status', async () => {
    writeConfig({ ntfyTopic: TOPIC, waitMinutes: 5 });
    addAgent(1, { title: 'Fix the build' });
    status(1, 'waiting');
    clock += 5 * MIN;
    await check();

    // The idle notification repeats `waiting`: still the same wait.
    status(1, 'waiting');
    clock += 5 * MIN;
    await check();
    expect(sent).toHaveLength(1);

    status(1, 'active');
    clock += MIN;
    status(1, 'waiting');
    clock += 5 * MIN;
    await check();
    expect(sent).toHaveLength(2);
  });

  it('skips sub-agents, teammates and background agents, but not remote ones', async () => {
    writeConfig({ ntfyTopic: TOPIC });
    addAgent(1, { leadAgentId: 4 });
    addAgent(2, { leadAgentId: 4, spawnToolUseId: 'toolu_1' });
    addAgent(3, { background: true });
    addAgent(4, {
      jsonlFile: '',
      hooksOnly: true,
      directoryName: 'web',
      remoteSource: { id: 'mac', label: 'Mac', kind: 'computer' },
    });
    for (const id of [1, 2, 3, 4]) status(id, 'waiting');

    clock += 20 * MIN;
    await check();

    expect(sent.map((s) => s.body)).toEqual(['⏳ web is waiting on you (20m)']);
  });

  it('is off without a config file, and with an invalid one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addAgent(1);
    status(1, 'waiting');
    clock += 30 * MIN;

    await check();
    writeConfig('{ not json');
    await check();
    writeConfig({ ntfyTopic: 'bad topic!' });
    await check();
    await check();

    expect(sent).toEqual([]);
    // One line per bad file, not per check.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('bad topic!');
  });

  it('re-reads the config when the file changes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeConfig({ ntfyTopic: TOPIC, waitMinutes: 30 });
    addAgent(1);
    status(1, 'waiting');
    clock += 10 * MIN;
    await check();
    expect(sent).toEqual([]);

    writeConfig({ ntfyTopic: TOPIC, ntfyServer: 'https://ntfy.example.com', waitMinutes: 10 });
    await check();
    expect(sent.map((s) => s.url)).toEqual([`https://ntfy.example.com/${TOPIC}`]);

    fs.rmSync(configFile);
    status(1, 'active');
    status(1, 'waiting');
    clock += 60 * MIN;
    await check();
    expect(sent).toHaveLength(1);
  });

  it('logs a failing send once per failure streak and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeConfig({ ntfyTopic: TOPIC });
    fetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND ntfy.sh');
    };
    addAgent(1);
    addAgent(2);
    status(1, 'waiting');
    status(2, 'waiting');
    clock += 15 * MIN;

    await expect(check()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    fetchImpl = async () => ({ ok: false, status: 429 });
    status(1, 'active');
    status(1, 'waiting');
    clock += 15 * MIN;
    await check();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOPIC);
  });

  it('gives up on a send after ALERTS_POST_TIMEOUT_MS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({ ntfyTopic: TOPIC });
    fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    addAgent(1);
    status(1, 'waiting');
    clock += 15 * MIN;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = check();
    await vi.advanceTimersByTimeAsync(ALERTS_POST_TIMEOUT_MS);
    await done;

    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('forgets a removed agent', async () => {
    writeConfig({ ntfyTopic: TOPIC });
    addAgent(1);
    status(1, 'waiting');
    store.delete(1);
    clock += 30 * MIN;

    await check();

    expect(sent).toEqual([]);
  });

  it('checks every ALERTS_CHECK_INTERVAL_MS once started, until disposed', async () => {
    writeConfig({ ntfyTopic: TOPIC });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const spy = vi.spyOn(runtime.alerts, 'check');

    runtime.startPhoneAlerts();
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ALERTS_CHECK_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(2);

    runtime.alerts.dispose();
    await vi.advanceTimersByTimeAsync(ALERTS_CHECK_INTERVAL_MS * 3);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
