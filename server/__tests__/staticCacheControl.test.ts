import { describe, expect, it } from 'vitest';

import { staticCacheControl } from '../src/httpServer.js';

describe('what a browser may keep of the office page', () => {
  it('keeps a hashed bundle for good and the font for a month', () => {
    expect(staticCacheControl('/app/dist/webview/assets/index-D3YQfswc.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(staticCacheControl('C:\\app\\webview\\assets\\index-B65mvrV_.css')).toContain(
      'immutable',
    );
    expect(staticCacheControl('/app/dist/webview/fonts/FSPixelSansUnicode-Regular.woff2')).toBe(
      'public, max-age=2592000',
    );
  });

  it('revalidates everything whose name does not change with its content', () => {
    for (const file of [
      '/app/dist/webview/index.html',
      '/app/dist/webview/manifest.webmanifest',
      '/app/dist/webview/assets/furniture-catalog.json',
      '/app/dist/webview/assets/furniture/PC/PC_FRONT_ON_1.png',
      '/app/dist/webview/assets/default-layout-1.json',
    ]) {
      expect(staticCacheControl(file)).toBeNull();
    }
  });
});
