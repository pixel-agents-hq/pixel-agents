import { useEffect } from 'react';

/**
 * Paints the page itself (html, body and the browser's theme colour) in `color`
 * while the calling component is mounted, and puts the old values back after.
 * A full-screen view needs it on iPhones: the home-bar safe area below the app
 * shows the page's background, not the view's.
 */
export function usePageBackground(color: string): void {
  useEffect(() => {
    const els = [document.documentElement, document.body];
    const before = els.map((el) => el.style.background);
    for (const el of els) el.style.background = color;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const themeBefore = meta?.content;
    if (meta) meta.content = color;
    return () => {
      els.forEach((el, i) => (el.style.background = before[i]));
      if (meta && themeBefore !== undefined) meta.content = themeBefore;
    };
  }, [color]);
}
