import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ["__tests__/**/*.test.ts"],
  },
});
