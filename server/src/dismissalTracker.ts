import { DISMISSED_COOLDOWN_MS } from './constants.js';

/**
 * Tracks file dismissal state for JSONL session files.
 *
 * Replaces 4 scattered module-global Maps/Sets that were previously in
 * `src/fileWatcher.ts`. All dismissal queries go through this class;
 * no direct Map manipulation from external consumers.
 */
export class DismissalTracker {
  /** Files temporarily dismissed by the user (closed via X). Keyed by path, value is
   *  the dismissal timestamp. Entries auto-expire after DISMISSED_COOLDOWN_MS. */
  private dismissed = new Map<string, number>();

  /** Files permanently dismissed by /clear reassignment. Never re-adopted in this session. */
  private permanent = new Set<string>();

  /** Mtime at seeding time (extension startup). If the actual mtime changes later,
   *  the file was resumed (--resume) and should be released from tracking. */
  private seeded = new Map<string, number>();

  /** /clear files waiting for a second scan tick before adoption. Gives the per-agent
   *  /clear detection loop time to claim the file first. */
  private pending = new Map<string, number>();

  // ── Temporary dismissals (user-close via X, 3-minute cooldown) ──────

  /** Dismiss a file temporarily. Accepts an optional timestamp for testing. */
  dismiss(path: string, timestamp = Date.now()): void {
    this.dismissed.set(path, timestamp);
  }

  /** Explicitly clear a temporary dismissal (e.g. on --resume). */
  clearDismissal(path: string): void {
    this.dismissed.delete(path);
  }

  /** True if the file is temporarily dismissed AND still within the cooldown window.
   *  Auto-cleans expired entries (returns false and deletes the stale map entry). */
  isDismissed(path: string): boolean {
    const timestamp = this.dismissed.get(path);
    if (timestamp === undefined) return false;
    if (Date.now() - timestamp < DISMISSED_COOLDOWN_MS) return true;
    // Expired: clean up and return false (file is adoptable again).
    this.dismissed.delete(path);
    return false;
  }

  // ── Permanent dismissals (/clear reassignment) ──────────────────────

  /** Permanently dismiss a file. Used by /clear reassignment so the old file
   *  is never re-adopted as an external session. */
  permanentlyDismiss(path: string): void {
    this.permanent.add(path);
  }

  isPermanentlyDismissed(path: string): boolean {
    return this.permanent.has(path);
  }

  // ── Seeded mtimes (startup snapshot for --resume detection) ─────────

  seedMtime(path: string, mtime: number): void {
    this.seeded.set(path, mtime);
  }

  getSeededMtime(path: string): number | undefined {
    return this.seeded.get(path);
  }

  clearSeededMtime(path: string): void {
    this.seeded.delete(path);
  }

  hasSeededMtime(path: string): boolean {
    return this.seeded.has(path);
  }

  // ── Pending /clear files (two-tick delay) ───────────────────────────

  registerPendingClear(path: string, timestamp = Date.now()): void {
    this.pending.set(path, timestamp);
  }

  hasPendingClear(path: string): boolean {
    return this.pending.has(path);
  }

  clearPendingClear(path: string): void {
    this.pending.delete(path);
  }

  // ── Reset (tests + dispose) ─────────────────────────────────────────

  resetAll(): void {
    this.dismissed.clear();
    this.permanent.clear();
    this.seeded.clear();
    this.pending.clear();
  }
}
