import { TOUCH_DEBUG_QUERY_PARAM } from '../constants.js';

/**
 * On-device diagnostics for the terminal touch-scroll gesture. iOS Safari
 * offers no console on a phone, so with ?touchdebug in the URL the gesture
 * handlers count their events into a small fixed overlay — one stalled
 * scroll then shows exactly which link of the chain went quiet (moves not
 * arriving vs. non-cancelable moves vs. a touchcancel vs. ticks not
 * emitted). No-ops entirely without the flag; not wired to React.
 */
export const touchDebugEnabled =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has(TOUCH_DEBUG_QUERY_PARAM);

let textNode: HTMLDivElement | null = null;
const counts = new Map<string, number>();
let lastKey = '';
let hudText = '';

function ensureHud(): HTMLDivElement {
  if (textNode) return textNode;
  // pixel-panel supplies themed colors; layout is fixed top-left, under the
  // top chrome. The panel itself is click-through so it never eats a
  // gesture — only the copy button takes taps.
  const hud = document.createElement('div');
  hud.className = 'pixel-panel';
  hud.style.position = 'fixed';
  hud.style.top = 'calc(env(safe-area-inset-top, 0px) + 48px)';
  hud.style.left = '8px';
  hud.style.zIndex = '100';
  hud.style.padding = '4px 6px';
  hud.style.fontSize = '15px';
  hud.style.lineHeight = '1.3';
  hud.style.pointerEvents = 'none';
  hud.style.maxWidth = '70vw';

  textNode = document.createElement('div');
  textNode.style.whiteSpace = 'pre-wrap';
  hud.appendChild(textNode);

  const btn = document.createElement('button');
  btn.textContent = 'copy';
  btn.style.pointerEvents = 'auto';
  btn.style.marginTop = '4px';
  btn.style.padding = '2px 8px';
  btn.style.fontSize = '15px';
  btn.style.background = 'var(--color-btn-bg)';
  btn.style.color = 'var(--color-text)';
  btn.style.border = '2px solid var(--color-border)';
  btn.style.borderRadius = '0';
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(hudText).then(
      () => {
        btn.textContent = 'copied!';
        setTimeout(() => (btn.textContent = 'copy'), 1200);
      },
      () => {
        btn.textContent = 'copy failed';
      },
    );
  });
  hud.appendChild(btn);

  document.body.appendChild(hud);
  return textNode;
}

/** Count one gesture event under a short key and repaint the HUD. */
export function touchDebugCount(key: string): void {
  if (!touchDebugEnabled) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  lastKey = key;
  hudText =
    [...counts.entries()].map(([k, v]) => `${k}:${String(v)}`).join(' ') + `\nlast:${lastKey}`;
  ensureHud().textContent = hudText;
}
