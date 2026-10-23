/**
 * The subscription usage meter's server half: the latest 5-hour and 7-day
 * usage the status line script reported (POST /api/usage), broadcast as
 * `subscriptionUsage` for the server room's wall display.
 *
 * - A report replaces the windows it carries; a window it omits is kept until
 *   it resets (one session's status line may run before its first response
 *   and know nothing yet, while another's knows both).
 * - A window is dropped at its reset time, and the office hears it.
 * - The last report is saved to ~/.pixel-agents/usage.json, so a restarted
 *   server shows the meter before Claude Code's next status line refresh.
 * - Only the two windows ever leave this module: the script forwards nothing
 *   else of the status line's input (no cwd, transcript path or session).
 *
 * Owned by AgentRuntime and registered module-wide, like the inbox tracker, so
 * the HTTP route (which the VS Code embedded server builds without a runtime)
 * and both surfaces' connect-time resend reach it with one line each.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SubscriptionUsage, UsageWindow } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { LAYOUT_FILE_DIR, USAGE_FILE_NAME } from '../constants.js';
import { writeJsonAtomic } from '../tasks/managerReports.js';
import type { SubscriptionUsageWindows } from './rateLimits.js';
import { parseRateLimits } from './rateLimits.js';

export interface UsageMeterOptions {
  /** Where the last report is kept: undefined = ~/.pixel-agents/usage.json,
   *  null = in memory only (tests, a bare store). */
  file?: string | null;
  /** Clock (tests). */
  now?: () => number;
}

interface SavedUsage {
  windows: SubscriptionUsageWindows;
  updatedAt: number;
}

export class UsageMeter {
  private windows: SubscriptionUsageWindows = {};
  private updatedAt: number | undefined;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string | null;
  private readonly now: () => number;
  private disposed = false;

  constructor(
    private readonly store: AgentStateStore,
    options: UsageMeterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.file =
      options.file === undefined
        ? path.join(os.homedir(), LAYOUT_FILE_DIR, USAGE_FILE_NAME)
        : options.file;
    this.load();
  }

  /** Is this the meter for that store? */
  tracks(store: AgentStateStore): boolean {
    return !this.disposed && store === this.store;
  }

  /**
   * A report from the status line script: `{ rate_limits: {...} }` as Claude
   * Code passed it. True when it held a usable window. Broadcasts and saves
   * only when the windows changed -- the status line runs after every
   * assistant message, mostly with the same numbers.
   */
  report(body: unknown): boolean {
    if (this.disposed) return false;
    const now = this.now();
    const rateLimits = (body as { rate_limits?: unknown } | null)?.rate_limits;
    const parsed = parseRateLimits(rateLimits, now);
    if (!parsed) return false;
    const next: SubscriptionUsageWindows = { ...this.live(now), ...parsed };
    this.updatedAt = now;
    if (sameWindows(next, this.windows)) return true;
    this.windows = next;
    this.save();
    this.scheduleExpiry();
    this.store.broadcast({ ...this.message() });
    return true;
  }

  /** What a connecting client is sent: the meter, once something is known. */
  snapshot(): SubscriptionUsage[] {
    return this.updatedAt === undefined ? [] : [this.message()];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }

  // ── Internals ──────────────────────────────────────────────

  private message(): SubscriptionUsage {
    return {
      type: 'subscriptionUsage',
      ...this.windows,
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
    };
  }

  /** The windows that have not reset by `now`. */
  private live(now: number): SubscriptionUsageWindows {
    const out: SubscriptionUsageWindows = {};
    if (this.windows.fiveHour && this.windows.fiveHour.resetsAt > now) {
      out.fiveHour = this.windows.fiveHour;
    }
    if (this.windows.sevenDay && this.windows.sevenDay.resetsAt > now) {
      out.sevenDay = this.windows.sevenDay;
    }
    return out;
  }

  /** Wake at the soonest reset to drop that window. */
  private scheduleExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const resets = [this.windows.fiveHour?.resetsAt, this.windows.sevenDay?.resetsAt].filter(
      (t): t is number => t !== undefined,
    );
    if (resets.length === 0) return;
    const delay = Math.max(0, Math.min(...resets) - this.now());
    this.expiry = setTimeout(() => this.expire(), delay);
    this.expiry.unref?.();
  }

  private expire(): void {
    this.expiry = null;
    if (this.disposed) return;
    const next = this.live(this.now());
    if (!sameWindows(next, this.windows)) {
      this.windows = next;
      this.save();
      this.store.broadcast({ ...this.message() });
    }
    this.scheduleExpiry();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<SavedUsage>;
      const now = this.now();
      if (typeof saved.updatedAt !== 'number' || !saved.windows) return;
      // Re-validated like a fresh report: the file is ours, but hand-editable.
      const windows = parseRateLimits(
        {
          five_hour: toRaw(saved.windows.fiveHour),
          seven_day: toRaw(saved.windows.sevenDay),
        },
        now,
      );
      this.updatedAt = saved.updatedAt;
      this.windows = windows ?? {};
      this.scheduleExpiry();
    } catch {
      // No report yet, or an unreadable file: the meter starts empty.
    }
  }

  private save(): void {
    if (!this.file || this.updatedAt === undefined) return;
    const saved: SavedUsage = { windows: this.windows, updatedAt: this.updatedAt };
    writeJsonAtomic(this.file, saved);
  }
}

/** A saved window back in the status line's shape, for the shared parser. */
function toRaw(w: unknown): unknown {
  const window = w as { usedPercentage?: unknown; resetsAt?: unknown } | undefined;
  return window
    ? { used_percentage: window.usedPercentage, resets_at: window.resetsAt }
    : undefined;
}

function sameWindow(a: UsageWindow | undefined, b: UsageWindow | undefined): boolean {
  return a?.usedPercentage === b?.usedPercentage && a?.resetsAt === b?.resetsAt;
}

function sameWindows(a: SubscriptionUsageWindows, b: SubscriptionUsageWindows): boolean {
  return sameWindow(a.fiveHour, b.fiveHour) && sameWindow(a.sevenDay, b.sevenDay);
}

// ── Registration (like inbox/inboxTracker.ts) ───────────────────

let usageMeter: UsageMeter | null = null;

export function setUsageMeter(meter: UsageMeter | null): void {
  usageMeter = meter;
}

/** The registered meter: for the usage route and the connect-time resend. */
export function getUsageMeter(): UsageMeter | null {
  return usageMeter;
}
