import { useEffect, useMemo, useRef, useState } from 'react';

import { sheetToDirectionSprites } from '../../../core/src/assets/characterSheet.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../../core/src/defaultCharacterProfiles.js';
import { useCast } from '../characters/castStore.js';
import { SHEET_W } from '../characters/sheet.js';
import {
  LOADING_DOTS_MS,
  LOADING_FADE_STOPS,
  LOADING_MAX_DOTS,
  LOADING_SCREEN_BG,
  LOADING_ZOOM,
  LOADING_ZOOM_DESKTOP,
  loadingShade,
} from '../constants.js';
import { useDevicePixelRatio } from '../hooks/useDevicePixelRatio.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { prefersReducedMotion } from '../hooks/usePresence.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import type { SpriteData } from '../office/types.js';
import { type LoadingArt, loadLoadingArt } from './loadingSceneArt.js';
import {
  type Drawable,
  LOADING_VIEW,
  loadingSceneAt,
  type SceneCast,
} from './loadingSceneLayout.js';

const faded = new WeakMap<SpriteData, Map<string, HTMLCanvasElement>>();

/** A drawable's sprite at `zoom` with its vignette (into `bg`, the screen's colour) and radial
 *  fade applied, cached. */
function fadedSprite(d: Drawable, zoom: number, bg: string): HTMLCanvasElement {
  let byKey = faded.get(d.sprite);
  if (!byKey) faded.set(d.sprite, (byKey = new Map()));
  const key = `${zoom}|${bg}`;
  const cached = byKey.get(key);
  if (cached) return cached;
  const src = getCachedSprite(d.sprite, zoom);
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const { x, y, solid, gone, vignetteFrom, vignetteDarkest } = d.fade!;
  const cx = (x - d.x) * zoom;
  const cy = (y - d.y) * zoom;
  // smoothstep, so neither gradient has a visible start or end
  const ease = (t: number) => t * t * (3 - 2 * t);
  const radial = (from: number, to: number, alphaAt: (t: number) => number) => {
    const gradient = ctx.createRadialGradient(cx, cy, from * zoom, cx, cy, to * zoom);
    for (let i = 0; i <= LOADING_FADE_STOPS; i++) {
      const t = i / LOADING_FADE_STOPS;
      gradient.addColorStop(t, loadingShade(alphaAt(t)));
    }
    return gradient;
  };
  // the vignette: the screen's colour, more of it further out...
  const vignette = document.createElement('canvas');
  vignette.width = canvas.width;
  vignette.height = canvas.height;
  const vctx = vignette.getContext('2d')!;
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, vignette.width, vignette.height);
  vctx.globalCompositeOperation = 'destination-in';
  vctx.fillStyle = radial(vignetteFrom, gone, (t) => vignetteDarkest * ease(t));
  vctx.fillRect(0, 0, vignette.width, vignette.height);
  // ...over the floor's own pixels only...
  ctx.globalCompositeOperation = 'source-atop';
  ctx.drawImage(vignette, 0, 0);
  // ...then the fade takes them away
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = radial(solid, gone, (t) => 1 - ease(t));
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  byKey.set(key, canvas);
  return canvas;
}

/** "Loading the office" with its dots counting up. The missing dots are kept (invisible) so
 *  the words never shift; reduced motion shows all three, still. */
function LoadingText() {
  const [dots, setDots] = useState(LOADING_MAX_DOTS);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = setInterval(() => setDots((n) => (n + 1) % (LOADING_MAX_DOTS + 1)), LOADING_DOTS_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-lg text-text-muted" role="status">
      Loading the office
      <span aria-hidden="true">
        {'.'.repeat(dots)}
        <span className="invisible">{'.'.repeat(LOADING_MAX_DOTS - dots)}</span>
      </span>
    </span>
  );
}

/** The default characters the scene is cast from, by name. */
const CAST_NAMES = { left: 'Suit', right: 'Dress', walker: 'Aura' } as const;

/**
 * The loading screen: while the office loads, a lamp-lit corner of it in a dark room — two of
 * the default characters typing at a table of PCs, a third walking circles around it, the cat
 * sitting on it, on a wood floor that fades into the dark. Drawn from art bundled with the
 * webview, so it needs nothing from the server; until that has decoded it is just the words.
 * Dev preview with hot reload: `npm run dev` in webview-ui, then /loading.html.
 */
export function LoadingScene() {
  const { renderer } = useCast();
  const dpr = useDevicePixelRatio();
  const isMobile = useIsMobile();
  const [art, setArt] = useState<LoadingArt | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void loadLoadingArt().then((a) => live && setArt(a));
    return () => {
      live = false;
    };
  }, []);

  const cast = useMemo((): SceneCast | null => {
    if (!renderer) return null;
    const sprites = (name: string) => {
      const profile = DEFAULT_CHARACTER_PROFILES.find((p) => p.name === name);
      return profile ? sheetToDirectionSprites(renderer.sheet(profile), SHEET_W) : null;
    };
    const left = sprites(CAST_NAMES.left);
    const right = sprites(CAST_NAMES.right);
    const walker = sprites(CAST_NAMES.walker);
    return left && right && walker ? { left, right, walker } : null;
  }, [renderer]);

  // The office's zoom rule: whole DEVICE pixels per sprite pixel.
  const zoom = isMobile ? LOADING_ZOOM : LOADING_ZOOM_DESKTOP;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !art || !cast) return;
    const ctx = canvas.getContext('2d');
    // the screen's own background, which the floor's vignette darkens into
    const bg = getComputedStyle(screenRef.current ?? document.body).backgroundColor;
    if (!ctx) return;
    canvas.width = LOADING_VIEW.w * zoom;
    canvas.height = LOADING_VIEW.h * zoom;
    ctx.imageSmoothingEnabled = false;
    const draw = (timeSec: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const d of loadingSceneAt(timeSec, art, cast)) {
        const img = d.fade ? fadedSprite(d, zoom, bg) : getCachedSprite(d.sprite, zoom);
        const x = (d.x - LOADING_VIEW.x) * zoom;
        const y = (d.y - LOADING_VIEW.y) * zoom;
        if (d.mirrored) {
          ctx.save();
          ctx.translate(x + img.width, y);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0);
          ctx.restore();
        } else {
          ctx.drawImage(img, x, y);
        }
      }
    };
    if (prefersReducedMotion()) {
      draw(0);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      draw((now - start) / 1000);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [art, cast, zoom]);

  return (
    <div
      ref={screenRef}
      className="w-full h-full flex flex-col items-center justify-center gap-16"
      style={{ background: LOADING_SCREEN_BG }}
    >
      {art && cast && (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="block"
          style={{ width: (LOADING_VIEW.w * zoom) / dpr, height: (LOADING_VIEW.h * zoom) / dpr }}
        />
      )}
      <LoadingText />
    </div>
  );
}
