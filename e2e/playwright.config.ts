import path from "path";

import { defineConfig } from "@playwright/test";

const artifactsDir = path.join(__dirname, "../test-results/e2e");

export default defineConfig({
  testDir: path.join(__dirname, "tests"),
  timeout: 120_000,
  globalSetup: path.join(__dirname, "global-setup.ts"),
  reporter: [
    ["list"],
    [
      "html",
      {
        // Must be outside outputDir to avoid Playwright clearing artifacts
        outputFolder: path.join(__dirname, "../playwright-report/e2e"),
        open: "never",
      },
    ],
  ],
  outputDir: artifactsDir,
  // NOTE: These settings are no-ops for Electron tests launched via electron.launch().
  // Playwright's built-in artifact handling only applies to browser contexts.
  // Video is configured in launch.ts (recordVideo option) and screenshots are
  // handled manually in the test's afterEach/finally blocks.
  use: {},
  // Single worker: VS Code windows don't share well in parallel on one display
  workers: 1,
});
