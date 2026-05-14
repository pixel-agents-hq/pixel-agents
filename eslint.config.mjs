import sharedConfig from "@minion-stack/lint-config/eslint.config.js";
import eslintConfigPrettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import typescriptEslint from "typescript-eslint";

import pixelAgentsPlugin from "./eslint-rules/pixel-agents-rules.mjs";

export default [
  // Shared @minion-stack preset: js.configs.recommended + tseslint.configs.recommended + ecma/source-type + baseline rules
  ...sharedConfig,
  {
    files: ["**/*.ts"],
  },
  {
    plugins: {
      "@typescript-eslint": typescriptEslint.plugin,
      "simple-import-sort": simpleImportSort,
      "pixel-agents": pixelAgentsPlugin,
    },

    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },

    rules: {
      // Preserved local rules from pre-adoption eslint.config.mjs
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],

      curly: "error",
      eqeqeq: "error",
      "no-throw-literal": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "pixel-agents/no-inline-colors": "error",
    },
  },
  {
    files: ["src/constants.ts"],
    rules: {
      "pixel-agents/no-inline-colors": "off",
    },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with Prettier
  eslintConfigPrettier,
];
