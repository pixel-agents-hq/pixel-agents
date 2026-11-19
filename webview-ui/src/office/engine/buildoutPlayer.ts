import type { TilePos } from '../../../../core/src/layout/types.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { layoutToTileMap } from '../layout/layoutSerializer.js';
import type { OfficeLayout, TileType as TileTypeVal } from '../types.js';
import {
  type BuildoutFrame,
  buildoutFrame,
  type BuildoutPlan,
  type BuildoutRender,
  changesStarted,
  dissolvingAt,
  planBuildout,
} from './buildout.js';

/**
 * The Buildout playing (an agent's layout edit building in), its clock and
 * what it shows now. The office's state is the new layout already; only
 * drawing reads this (OfficeState.shownLayout / shownTileMap, `render`).
 */
export class BuildoutPlayer {
  private playing: {
    plan: BuildoutPlan;
    elapsed: number;
    started: number;
    frame: BuildoutFrame;
    tileMap: TileTypeVal[][];
    beforeTileMap: TileTypeVal[][];
  } | null = null;

  /** Start building `after` in over `before` from `origin` (buildout.ts).
   *  The plan, or null when nothing visible changes (nothing plays). */
  start(
    before: OfficeLayout,
    after: OfficeLayout,
    origin: TilePos,
    shift?: { col: number; row: number },
  ): BuildoutPlan | null {
    const plan = planBuildout(before, after, origin, {
      shift,
      footprint: (type) => {
        const entry = getCatalogEntry(type);
        return entry ? { w: entry.footprintW, h: entry.footprintH } : null;
      },
    });
    if (!plan) return null;
    const frame = buildoutFrame(plan, 0);
    this.playing = {
      plan,
      elapsed: 0,
      started: changesStarted(plan, 0),
      frame,
      tileMap: layoutToTileMap(frame.layout),
      beforeTileMap: layoutToTileMap(plan.before),
    };
    return plan;
  }

  /** End the Buildout under way, if any: what it was building shows at once. */
  stop(): void {
    this.playing = null;
  }

  /** Whether a Buildout is playing. */
  get isPlaying(): boolean {
    return this.playing !== null;
  }

  /** Advance the clock. True when the furniture drawn changed (a change
   *  started, or the Buildout ended). */
  advance(dt: number): boolean {
    const b = this.playing;
    if (!b) return false;
    b.elapsed += dt;
    if (b.elapsed >= b.plan.duration) {
      this.playing = null;
      return true;
    }
    const started = changesStarted(b.plan, b.elapsed);
    const layoutChanged = started !== b.started;
    b.started = started;
    if (layoutChanged) {
      b.frame = buildoutFrame(b.plan, b.elapsed);
      b.tileMap = layoutToTileMap(b.frame.layout);
    } else {
      b.frame = { ...b.frame, dissolving: dissolvingAt(b.plan, b.elapsed) };
    }
    return layoutChanged;
  }

  /** The layout the Buildout shows now, or null when none plays. */
  layout(): OfficeLayout | null {
    return this.playing?.frame.layout ?? null;
  }

  /** The tile map the Buildout shows now, or null when none plays. */
  tileMap(): TileTypeVal[][] | null {
    return this.playing?.tileMap ?? null;
  }

  /** What the renderer needs of the Buildout playing (null when none). */
  render(): BuildoutRender | null {
    const b = this.playing;
    return b
      ? { dissolving: b.frame.dissolving, before: b.plan.before, beforeTileMap: b.beforeTileMap }
      : null;
  }
}
