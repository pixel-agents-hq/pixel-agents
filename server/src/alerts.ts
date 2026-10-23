/**
 * Phone alerts: when an agent has been waiting on the user for `waitMinutes`,
 * one ntfy notification goes out for that wait. The user subscribes to the
 * topic in the ntfy app. Standalone only (cli.ts starts it); owned by
 * AgentRuntime.
 *
 * Config: ~/.pixel-agents/alerts.json
 *   { "ntfyTopic": "<topic>", "ntfyServer": "https://ntfy.sh", "waitMinutes": 15 }
 * Only the topic is required. An absent or invalid file means alerts are off;
 * the file is re-read whenever its mtime (or size) changes.
 *
 * Every ALERTS_CHECK_INTERVAL_MS, each agent the ProgressTracker reports as
 * waiting (its waitingSince) for at least waitMinutes, and not yet alerted for
 * that same waitingSince, gets one POST to `${ntfyServer}/${ntfyTopic}`. A new
 * wait (a new waitingSince) may alert again; a repeated `waiting` status is the
 * same wait. Each wait is attempted once: a failed send is not retried.
 * Sub-agents, teammates and background agents are skipped.
 *
 * The body names the task title and the repo, and nothing else: never a
 * command, a path or a tool input. Failures are logged once per failure
 * streak; nothing here throws.
 *
 * notify() sends one notification of another kind through the same config and
 * send path: the Manager's `📋 Daily report: N done, N open, N waiting`
 * (tasks/managerReports.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import {
  ALERTS_CHECK_INTERVAL_MS,
  ALERTS_FILE_NAME,
  ALERTS_NOTIFICATION_TAGS,
  ALERTS_NOTIFICATION_TITLE,
  ALERTS_POST_TIMEOUT_MS,
  ALERTS_UNNAMED_AGENT,
  DEFAULT_ALERTS_WAIT_MINUTES,
  DEFAULT_NTFY_SERVER,
  LAYOUT_FILE_DIR,
  NTFY_TOPIC_PATTERN,
} from './constants.js';
import type { ProgressTracker } from './progress/progressTracker.js';
import type { AgentState } from './types.js';

const MINUTE_MS = 60_000;

/** The subset of fetch the alerts use (injectable for tests). */
export type AlertFetch = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface PhoneAlertsOptions {
  /** alerts.json location. Default: ~/.pixel-agents/alerts.json. */
  configFile?: string;
  /** Default: the global fetch. */
  fetch?: AlertFetch;
  /** Clock (tests). */
  now?: () => number;
}

/** The ntfy headers that tell one kind of notification from another. ASCII
 *  only: they are HTTP header values. */
export interface NotificationKind {
  title: string;
  tags: string;
}

/** An agent left waiting on the user. */
const WAITING_NOTIFICATION: NotificationKind = {
  title: ALERTS_NOTIFICATION_TITLE,
  tags: ALERTS_NOTIFICATION_TAGS,
};

export interface AlertsConfig {
  topic: string;
  /** No trailing slash. */
  server: string;
  waitMinutes: number;
}

/** Validate an alerts.json body. The reason never echoes the topic. */
export function parseAlertsConfig(raw: unknown): { config: AlertsConfig } | { reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { reason: 'expected a JSON object' };
  }
  const { ntfyTopic, ntfyServer, waitMinutes } = raw as Record<string, unknown>;
  if (typeof ntfyTopic !== 'string' || !NTFY_TOPIC_PATTERN.test(ntfyTopic)) {
    return { reason: 'ntfyTopic must be 8-64 letters, digits, "-" or "_"' };
  }
  let server = DEFAULT_NTFY_SERVER;
  if (ntfyServer !== undefined) {
    const parsed = typeof ntfyServer === 'string' ? serverUrl(ntfyServer) : undefined;
    if (!parsed) return { reason: 'ntfyServer must be a plain http(s) URL' };
    server = parsed;
  }
  let minutes = DEFAULT_ALERTS_WAIT_MINUTES;
  if (waitMinutes !== undefined) {
    if (typeof waitMinutes !== 'number' || !Number.isFinite(waitMinutes) || waitMinutes <= 0) {
      return { reason: 'waitMinutes must be a positive number' };
    }
    minutes = waitMinutes;
  }
  return { config: { topic: ntfyTopic, server, waitMinutes: minutes } };
}

/** An http(s) server URL with no credentials, query or fragment, minus its trailing slash. */
function serverUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Who an alert is about: top-level, foreground agents only. */
function alertable(agent: AgentState): boolean {
  return !agent.background && agent.leadAgentId === undefined && !agent.spawnToolUseId;
}

/** `⏳ <title> · <repo> is waiting on you (15m)`; just the repo without a title. */
function alertBody(agent: AgentState, waitedMs: number): string {
  const repo = agent.directoryName || ALERTS_UNNAMED_AGENT;
  const who = agent.title ? `${agent.title} · ${repo}` : repo;
  const minutes = Math.max(1, Math.floor(waitedMs / MINUTE_MS));
  return `⏳ ${who} is waiting on you (${minutes}m)`;
}

export class PhoneAlerts {
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private checking = false;
  private failing = false;
  private config: AlertsConfig | null = null;
  /** mtime:size of the config last read; 'absent' when there was none. */
  private configStamp: string | null = null;
  /** The waitingSince each agent was last alerted for. */
  private readonly alerted = new Map<number, number>();
  private readonly configFile: string;
  private readonly fetch: AlertFetch;
  private readonly now: () => number;

  constructor(
    private readonly store: AgentStateStore,
    private readonly progress: ProgressTracker,
    options: PhoneAlertsOptions = {},
  ) {
    this.configFile =
      options.configFile ?? path.join(os.homedir(), LAYOUT_FILE_DIR, ALERTS_FILE_NAME);
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    store.on('agentRemoved', this.onAgentRemoved);
  }

  /** Check now, then every ALERTS_CHECK_INTERVAL_MS. */
  start(): void {
    if (this.timer || this.disposed) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), ALERTS_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.alerted.clear();
  }

  /**
   * Send one notification of another kind -- the Manager's daily report --
   * through the same topic and send path. True when it went out; false while
   * alerts are off (no valid alerts.json) or when the send failed. Never throws.
   * The body is the caller's to keep free of commands and paths.
   */
  async notify(body: string, kind: NotificationKind): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const config = this.loadConfig();
      return config ? await this.send(config, body, kind) : false;
    } catch (err) {
      console.error('[Pixel Agents] Phone alerts: notify failed:', err);
      return false;
    }
  }

  /** One pass: alert every agent whose wait just crossed the threshold. Never throws. */
  async check(): Promise<void> {
    if (this.disposed || this.checking) return;
    this.checking = true;
    try {
      const config = this.loadConfig();
      if (!config) return;
      const now = this.now();
      const due: string[] = [];
      for (const [id, agent] of this.store) {
        if (!alertable(agent)) continue;
        const since = this.progress.waitingSinceOf(id);
        if (since === undefined || this.alerted.get(id) === since) continue;
        const waited = now - since;
        if (waited < config.waitMinutes * MINUTE_MS) continue;
        // Marked before sending: one attempt per wait, whatever the outcome.
        this.alerted.set(id, since);
        due.push(alertBody(agent, waited));
      }
      for (const body of due) {
        if (this.disposed) return;
        await this.send(config, body);
      }
    } catch (err) {
      console.error('[Pixel Agents] Phone alerts: check failed:', err);
    } finally {
      this.checking = false;
    }
  }

  // ── Config ───────────────────────────────────────────────

  /** The current config, re-read when the file changed; null while alerts are off. */
  private loadConfig(): AlertsConfig | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.configFile);
    } catch {
      if (this.configStamp !== 'absent' && this.config) {
        console.log('[Pixel Agents] Phone alerts off: alerts.json removed');
      }
      this.configStamp = 'absent';
      this.config = null;
      return null;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this.configStamp) return this.config;
    this.configStamp = stamp;
    this.config = null;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
    } catch {
      console.warn(`[Pixel Agents] Phone alerts off: ${this.configFile} is not valid JSON`);
      return null;
    }
    const parsed = parseAlertsConfig(raw);
    if ('reason' in parsed) {
      console.warn(`[Pixel Agents] Phone alerts off: ${this.configFile}: ${parsed.reason}`);
      return null;
    }
    this.config = parsed.config;
    console.log(
      `[Pixel Agents] Phone alerts on: ntfy after ${parsed.config.waitMinutes} min waiting on you`,
    );
    return this.config;
  }

  // ── Sending ──────────────────────────────────────────────

  /** POST one notification; true when ntfy took it. */
  private async send(
    config: AlertsConfig,
    body: string,
    kind: NotificationKind = WAITING_NOTIFICATION,
  ): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ALERTS_POST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const res = await this.fetch(`${config.server}/${config.topic}`, {
        method: 'POST',
        body,
        headers: {
          Title: kind.title,
          Tags: kind.tags,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (this.failing) {
        this.failing = false;
        console.log('[Pixel Agents] Phone alerts: sending again');
      }
      return true;
    } catch (err) {
      if (this.failing) return false;
      this.failing = true;
      // The reason only, never the URL: it carries the topic, which is the secret.
      const reason = controller.signal.aborted
        ? `no answer in ${ALERTS_POST_TIMEOUT_MS / 1000}s`
        : (err instanceof Error ? err.message : String(err)).split(config.topic).join('<topic>');
      console.warn(
        `[Pixel Agents] Phone alert not sent (${reason}); logged once until one goes through.`,
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private readonly onAgentRemoved = (id: number): void => {
    this.alerted.delete(id);
  };
}
