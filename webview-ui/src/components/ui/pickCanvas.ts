/** Fill a canvas's backing store pixel by pixel: `rgbAt` gets each pixel's fractional position (0-1 inclusive). */
export function paintPickCanvas(
  canvas: HTMLCanvasElement | null,
  rgbAt: (fx: number, fy: number) => readonly [number, number, number],
): void {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const { width: w, height: h } = canvas;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgbAt(w > 1 ? x / (w - 1) : 0, h > 1 ? y / (h - 1) : 0);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
