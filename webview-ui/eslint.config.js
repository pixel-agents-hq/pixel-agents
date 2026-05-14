import js from "@eslint/js";
import sharedConfig from "@minion-stack/lint-config/eslint.config.js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

import pixelAgentsPlugin from "../eslint-rules/pixel-agents-rules.mjs";

// Shared @minion-stack preset is spread first so local rules/overrides take precedence.
// Scope each shared config entry to TS/TSX so tseslint's type-aware parser doesn't
// stumble on the JS config file itself (which sits in a directory with nested
// node_modules containing another tsconfig).
const sharedTsOnly = sharedConfig.map((c) =>
  c.ignores ? c : { ...c, files: c.files ?? ["**/*.{ts,tsx}"] },
);

export default defineConfig([
  ...sharedTsOnly,
  globalIgnores(["dist", "eslint.config.js"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: {
      "simple-import-sort": simpleImportSort,
      "pixel-agents": pixelAgentsPlugin,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // Pin the root-dir explicitly — nested node_modules/@minion-stack/lint-config
        // contains its own tsconfig which otherwise creates parser ambiguity.
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      // These react-hooks rules misfire on this project's imperative game-state patterns:
      // - immutability: singleton OfficeState/EditorState mutations are by design
      // - refs: containerRef reads during render feed canvas pipeline, not React state
      // - set-state-in-effect: timer-based animations and async error handling are legitimate
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "pixel-agents/no-inline-colors": "error",
      "pixel-agents/pixel-shadow": "error",
      "pixel-agents/pixel-font": "error",
    },
  },
  {
    files: ["src/constants.ts", "src/fonts/**", "src/office/sprites/**"],
    rules: {
      "pixel-agents/no-inline-colors": "off",
      "pixel-agents/pixel-shadow": "off",
      "pixel-agents/pixel-font": "off",
    },
  },
  eslintConfigPrettier,
]);
