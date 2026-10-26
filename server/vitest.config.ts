import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'server';

// Allure results are large; only write them on CI or with ALLURE=1.
const allureEnabled = Boolean(process.env['CI'] || process.env['ALLURE']);

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['allure-vitest/setup', '__tests__/isolateHome.setup.ts'],
    reporters: [
      'default',
      ...(allureEnabled
        ? [
            ['allure-vitest/reporter', { resultsDir: '../allure-results/server' }] as [
              string,
              Record<string, unknown>,
            ],
          ]
        : []),
    ],
  },
});
