import { useEffect, useRef } from 'react';

import {
  KEY_PAN_GLIDE_RATE_PER_SEC,
  KEY_PAN_HOLD_TILES_PER_SEC,
  KEY_PAN_STEP_TILES,
  MAX_DELTA_TIME_SEC,
} from '../../constants.js';
import { isTypingInTerminal } from '../../terminal/terminalDom.js';
import type { PanDirection } from '../camera.js';
import { isEditableTarget, keyPanDirection, keyPanImpulse, stepKeyPan } from '../camera.js';
import { subscribePanInput } from '../panInput.js';
import { TILE_SIZE } from '../types.js';

interface KeyboardPanOptions {
  zoom: number;
  panRef: { current: { x: number; y: number } };
  clampPan: (x: number, y: number) => { x: number; y: number };
  /** WASD pan too. Off in the layout editor, where letters are tool keys
   *  (R rotate, T toggle, …); the arrows pan everywhere. */
  letters: boolean;
  /** A key pan began — the camera stops following anything automatically. */
  onManualPan: () => void;
}

const dirKey = (d: PanDirection) => `${d.dx},${d.dy}`;

/**
 * Arrow keys (and WASD outside the editor) pan the office camera: a press
 * glides a few tiles, holding keeps it moving (office/camera.stepKeyPan).
 * Window listeners, skipped while focus is in anything that takes typing — an
 * input, a textarea (every terminal pane's xterm input), a contenteditable —
 * and for modifier chords, which belong to the editor and the browser.
 *
 * The rAF loop only runs while something is moving, and reads the latest zoom
 * and callbacks through a ref so a zoom change mid-glide doesn't tear the
 * listeners down.
 */
export function useKeyboardPan(options: KeyboardPanOptions): void {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    // Held view directions, keyed by direction (two keys for one direction —
    // ArrowLeft and A — count once).
    const held = new Map<string, PanDirection>();
    let glideX = 0;
    let glideY = 0;
    let rafId = 0;
    let lastTime = 0;

    const tilePx = () => TILE_SIZE * latest.current.zoom;

    const frame = (time: number) => {
      const dt = lastTime ? Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC) : 0;
      lastTime = time;
      let heldX = 0;
      let heldY = 0;
      for (const d of held.values()) {
        heldX += d.dx;
        heldY += d.dy;
      }
      const step = stepKeyPan({
        glideX,
        glideY,
        heldX: Math.sign(heldX),
        heldY: Math.sign(heldY),
        dt,
        glideRate: KEY_PAN_GLIDE_RATE_PER_SEC,
        holdSpeed: KEY_PAN_HOLD_TILES_PER_SEC * tilePx(),
      });
      const { panRef, clampPan } = latest.current;
      const want = { x: panRef.current.x + step.panDX, y: panRef.current.y + step.panDY };
      const next = clampPan(want.x, want.y);
      panRef.current = next;
      // Pressed against the pan limit: drop the glide on that axis instead of
      // leaving it to bleed out invisibly into the clamp.
      glideX = next.x === want.x ? step.glideX : 0;
      glideY = next.y === want.y ? step.glideY : 0;
      if (held.size > 0 || glideX !== 0 || glideY !== 0) {
        rafId = requestAnimationFrame(frame);
      } else {
        rafId = 0;
        lastTime = 0;
      }
    };
    const run = () => {
      if (rafId === 0) rafId = requestAnimationFrame(frame);
    };

    // A direction goes down: the first press queues a step, holding drifts on.
    const press = (dir: PanDirection) => {
      if (!held.has(dirKey(dir))) {
        const impulse = keyPanImpulse(dir, KEY_PAN_STEP_TILES * tilePx());
        glideX += impulse.x;
        glideY += impulse.y;
      }
      held.set(dirKey(dir), dir);
      latest.current.onManualPan();
      run();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      if (isEditableTarget(active) || isTypingInTerminal(active)) return;
      const dir = keyPanDirection(e.key, latest.current.letters);
      if (!dir) return;
      e.preventDefault(); // arrows would scroll the page otherwise
      // OS auto-repeat fires keydown again and again while held: the hold
      // drift covers that, so only the first press queues a step.
      if (e.repeat && held.has(dirKey(dir))) return;
      press(dir);
    };
    // Keyup always releases, whatever has focus now and whether or not WASD
    // is enabled — a key pressed before focus moved must not stay held.
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = keyPanDirection(e.key, true);
      if (dir) held.delete(dirKey(dir));
    };
    // Alt-tab with a key down never delivers its keyup here.
    const onBlur = () => held.clear();
    // The on-screen arrow pad (ZoomControls) drives the same pan.
    const unsubscribePad = subscribePanInput((e) => {
      if (e.kind === 'press') press(e.dir);
      else if (e.kind === 'release') held.delete(dirKey(e.dir));
      else held.clear();
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      unsubscribePad();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);
}
