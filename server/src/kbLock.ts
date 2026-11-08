/**
 * The Knowledge Base single-writer lock: generation-numbered symlinks.
 *
 * kb/.lock.<n> is a symlink whose target string IS the lock record,
 * `kbwriter:<pid>:<instance>:<startedAt>`. symlink(2) creates the name and its
 * content in one atomic call (EEXIST when the name is taken), so there is never
 * a lock that exists but is not yet readable. The holder is the owner of the
 * highest generation.
 *
 * Acquire (first mutating use; held until the process exits):
 *   a. readdir; no generation at all -> symlink .lock.1 (EEXIST: start over).
 *   b. readlink the highest .lock.n. Not a symlink, unreadable, or not the
 *      expected format -> an unparseable holder: never taken over, `locked`.
 *      Our own instance -> already held.
 *   c. Holder pid alive (kill(pid, 0) succeeds or EPERM) -> `locked`.
 *   d. Holder pid dead (ESRCH) -> symlink .lock.<n+1> (EEXIST: start over), then
 *      confirm by a fresh readdir that n+1 is the highest and its target is ours;
 *      only then remove lower generations, best effort.
 *   At most KB_LOCK_MAX_ATTEMPTS passes; then `locked`.
 *
 * Invariant: the highest generation is never deleted -- not on exit, not by a
 * process whose confirmation failed. Lower generations are removed only by a
 * confirmed holder of a higher one. So the highest number never decreases, a
 * new generation is only created over a dead holder, and two live holders
 * cannot both pass confirmation. The one failure mode is a recycled pid making
 * a dead holder look alive: that is `locked`, the safe direction, and needs a
 * person to remove every generation (and restart).
 *
 * Every mutating operation re-checks `verifyHeld()` before its first change.
 * The fs operations and the liveness check are injectable for deterministic
 * interleaving tests.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  KB_LOCK_MAX_ATTEMPTS,
  KB_LOCK_NAME_PATTERN,
  KB_LOCK_NAME_PREFIX,
  KB_LOCK_TARGET_PATTERN,
  KB_LOCK_TARGET_PREFIX,
} from './constants.js';
import { errnoCode, kbLog } from './kbFiles.js';

/** The filesystem calls the lock makes, injectable for interleaving tests. */
export interface KbLockFs {
  readdir(dir: string): Promise<string[]>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(linkPath: string): Promise<string>;
  unlink(linkPath: string): Promise<void>;
}

export interface KbLockOptions {
  fs?: KbLockFs;
  isProcessAlive?: (pid: number) => boolean;
  pid?: number;
  instance?: string;
  startedAt?: number;
}

const realLockFs: KbLockFs = {
  readdir: (dir) => fs.promises.readdir(dir),
  symlink: (target, linkPath) => fs.promises.symlink(target, linkPath),
  readlink: (linkPath) => fs.promises.readlink(linkPath),
  unlink: (linkPath) => fs.promises.unlink(linkPath),
};

/** True unless the OS says no process has this pid. EPERM is someone else's live process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) !== 'ESRCH';
  }
}

/** The generation a directory entry names, or null for anything else (a zero,
 *  a leading zero, a sign, more than 12 digits, another file). */
export function lockGeneration(name: string): number | null {
  const match = KB_LOCK_NAME_PATTERN.exec(name);
  return match ? Number(match[1]) : null;
}

interface LockRecord {
  pid: number;
  instance: string;
}

function parseLockTarget(target: string): LockRecord | null {
  const match = KB_LOCK_TARGET_PATTERN.exec(target);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, instance: match[2] };
}

export type KbLockState = 'held' | 'locked';

export class KbWriterLock {
  private readonly fs: KbLockFs;
  private readonly alive: (pid: number) => boolean;
  readonly instance: string;
  private readonly target: string;
  private heldGeneration: number | null = null;
  private acquiring: Promise<KbLockState> | null = null;

  constructor(
    private readonly root: string,
    options: KbLockOptions = {},
  ) {
    this.fs = options.fs ?? realLockFs;
    this.alive = options.isProcessAlive ?? isProcessAlive;
    this.instance = options.instance ?? crypto.randomUUID();
    const pid = options.pid ?? process.pid;
    const startedAt = options.startedAt ?? Date.now();
    this.target = `${KB_LOCK_TARGET_PREFIX}:${pid}:${this.instance}:${startedAt}`;
  }

  get held(): boolean {
    return this.heldGeneration !== null;
  }

  private linkPath(generation: number): string {
    return path.join(this.root, `${KB_LOCK_NAME_PREFIX}${generation}`);
  }

  /** The generations present, ascending. */
  private async generations(): Promise<number[]> {
    const names = await this.fs.readdir(this.root);
    const found: number[] = [];
    for (const name of names) {
      const generation = lockGeneration(name);
      if (generation !== null) found.push(generation);
    }
    return found.sort((a, b) => a - b);
  }

  private async readTarget(generation: number): Promise<string | null> {
    try {
      return await this.fs.readlink(this.linkPath(generation));
    } catch {
      return null;
    }
  }

  /** Create a generation; 'exists' when another process took that number first. */
  private async create(generation: number): Promise<'created' | 'exists'> {
    try {
      await this.fs.symlink(this.target, this.linkPath(generation));
      return 'created';
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') return 'exists';
      throw err;
    }
  }

  /** Whether `generation` is the highest one present and holds our record. */
  private async isHighestAndOurs(generation: number): Promise<boolean> {
    const generations = await this.generations();
    if (generations.length === 0 || generations[generations.length - 1] !== generation) {
      return false;
    }
    return (await this.readTarget(generation)) === this.target;
  }

  /** Remove every generation below ours, best effort. Only ever called by a
   *  confirmed holder, and never on our own (the highest) generation. */
  private async removeLowerGenerations(own: number): Promise<void> {
    let generations: number[];
    try {
      generations = await this.generations();
    } catch {
      return;
    }
    for (const generation of generations) {
      if (generation >= own) continue;
      await this.fs.unlink(this.linkPath(generation)).catch(() => undefined);
    }
  }

  private async confirm(generation: number): Promise<KbLockState> {
    if (!(await this.isHighestAndOurs(generation))) return 'locked';
    this.heldGeneration = generation;
    await this.removeLowerGenerations(generation);
    return 'held';
  }

  private async attemptAcquire(): Promise<KbLockState> {
    for (let attempt = 0; attempt < KB_LOCK_MAX_ATTEMPTS; attempt++) {
      const generations = await this.generations();
      if (generations.length === 0) {
        if ((await this.create(1)) === 'exists') continue;
        return this.confirm(1);
      }
      const highest = generations[generations.length - 1];
      const target = await this.readTarget(highest);
      const record = target === null ? null : parseLockTarget(target);
      if (!record) {
        kbLog('the writer lock holder record is unreadable; it needs manual attention');
        return 'locked';
      }
      if (record.instance === this.instance) {
        if (target !== this.target) return 'locked';
        this.heldGeneration = highest;
        return 'held';
      }
      if (this.alive(record.pid)) return 'locked';
      if ((await this.create(highest + 1)) === 'exists') continue;
      return this.confirm(highest + 1);
    }
    return 'locked';
  }

  /** Acquire (once; concurrent callers share one attempt). Never throws: an
   *  unexpected fs error is logged and answered `locked`. */
  acquire(): Promise<KbLockState> {
    if (this.heldGeneration !== null) return Promise.resolve('held');
    if (!this.acquiring) {
      this.acquiring = this.attemptAcquire()
        .catch((err: unknown) => {
          kbLog('the writer lock could not be acquired', { errno: errnoCode(err) });
          return 'locked' as const;
        })
        .finally(() => {
          this.acquiring = null;
        });
    }
    return this.acquiring;
  }

  /** Defense in depth, before a mutation's first change: a fresh readdir must
   *  still show our generation as the highest. On failure the lock is dropped
   *  (in memory only -- nothing on disk is touched). */
  async verifyHeld(): Promise<boolean> {
    const generation = this.heldGeneration;
    if (generation === null) return false;
    let ok = false;
    try {
      ok = await this.isHighestAndOurs(generation);
    } catch (err) {
      kbLog('the writer lock could not be re-checked', { errno: errnoCode(err) });
    }
    if (!ok) this.heldGeneration = null;
    return ok;
  }
}
