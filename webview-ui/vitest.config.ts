import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'webview';

// Allure results are large; only write them on CI or with ALLURE=1.
const allureEnabled = Boolean(process.env['CI'] || process.env['ALLURE']);

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/*.test.ts'],
    testTimeout: 30_000,
    // Tests bind fixed ports (Vite dev server, vite preview) and share the
    // global `window.postMessage` listener in browser-transport. Serial run
    // avoids port collisions and listener crosstalk.
    fileParallelism: false,
    setupFiles: ['allure-vitest/setup'],
    reporters: [
      'default',
      ...(allureEnabled
        ? [
            [
              'allure-vitest/reporter',
              { resultsDir: path.resolve(rootDir, '../allure-results/webview') },
            ] as [string, Record<string, unknown>],
          ]
        : []),
    ],
  },
});
