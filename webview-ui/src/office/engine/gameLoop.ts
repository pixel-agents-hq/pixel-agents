import { MAX_DELTA_TIME_SEC } from '../../constants.js';

/** @internal */
export interface GameLoopCallbacks {
  update: (dt: number) => void;
  render: (ctx: CanvasRenderingContext2D) => void;
}

/** @internal */
export interface GameLoop {
  stop: () => void;
  /** Draw the current state now, without advancing it: resizing a canvas
   *  clears it, and the next frame would otherwise paint it blank. */
  redraw: () => void;
}

export function startGameLoop(canvas: HTMLCanvasElement, callbacks: GameLoopCallbacks): GameLoop {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let lastTime = 0;
  let rafId = 0;
  let stopped = false;

  const frame = (time: number) => {
    if (stopped) return;
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC);
    lastTime = time;

    callbacks.update(dt);

    ctx.imageSmoothingEnabled = false;
    callbacks.render(ctx);

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    },
    redraw: () => {
      if (stopped) return;
      ctx.imageSmoothingEnabled = false;
      callbacks.render(ctx);
    },
  };
}
