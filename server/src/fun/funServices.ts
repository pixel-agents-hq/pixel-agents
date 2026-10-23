/**
 * The server half of the fun phase: the week wall's totals and the weather.
 * Owned by AgentRuntime; registered module-wide so both surfaces' connect-time
 * resend (agentActivityResend) can find it, like the ProgressTracker.
 */

import * as os from 'os';
import * as path from 'path';

import type { Weather, WeekStats } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { DAILY_STATS_DIR_NAME, LAYOUT_FILE_DIR } from '../constants.js';
import type { WeatherServiceOptions } from './weather.js';
import { WeatherService } from './weather.js';
import { WeekStatsTracker } from './weekStats.js';

export interface FunServicesOptions {
  /** Daily files: undefined = ~/.pixel-agents/daily, null = none (in-memory runtime). */
  dailyDir?: string | null;
  now?: () => number;
  weather?: Partial<WeatherServiceOptions>;
}

export class FunServices {
  readonly week: WeekStatsTracker;
  readonly weather: WeatherService;
  private disposed = false;

  constructor(
    private readonly store: AgentStateStore,
    options: FunServicesOptions = {},
  ) {
    const dataDir = path.join(os.homedir(), LAYOUT_FILE_DIR);
    const dailyDir =
      options.dailyDir === undefined ? path.join(dataDir, DAILY_STATS_DIR_NAME) : options.dailyDir;
    this.week = new WeekStatsTracker(store, { dailyDir, now: options.now });
    this.weather = new WeatherService(store, { dataDir, ...options.weather });
  }

  /** Is this the instance for that store? */
  tracks(store: AgentStateStore): boolean {
    return !this.disposed && store === this.store;
  }

  /** What a connecting client is sent: the week, and the weather if known. */
  snapshot(): Array<WeekStats | Weather> {
    const weather = this.weather.snapshot();
    return weather ? [this.week.snapshot(), weather] : [this.week.snapshot()];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.week.dispose();
    this.weather.stop();
  }
}

let current: FunServices | null = null;

export function setFunServices(services: FunServices | null): void {
  current = services;
}

/** The registered services, for the connect-time resend. */
export function getFunServices(): FunServices | null {
  return current;
}
