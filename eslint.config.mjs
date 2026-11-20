import typescriptEslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import { noComputedRecursiveDelete } from './eslint-rules/noComputedRecursiveDelete.mjs';
import pixelAgentsPlugin from './eslint-rules/pixel-agents-rules.mjs';

export default [
  {
    files: ['**/*.ts'],
  },
  {
    plugins: {
      '@typescript-eslint': typescriptEslint.plugin,
      'simple-import-sort': simpleImportSort,
      'pixel-agents': pixelAgentsPlugin,
    },

    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },

    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],

      curly: 'error',
      eqeqeq: 'error',
      'no-throw-literal': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'pixel-agents/no-inline-colors': 'error',
    },
  },
  {
    // Wardrobe art data: the colour pickers' swatches.
    files: ['adapters/vscode/constants.ts', 'core/src/characters/art/**'],
    rules: {
      'pixel-agents/no-inline-colors': 'off',
    },
  },
  {
    // Tests delete folders only through their guard (eslint-rules/noComputedRecursiveDelete.mjs).
    files: ['server/__tests__/**/*.ts', 'e2e/**/*.ts'],
    ignores: ['server/__tests__/helpers/removeTempDir.ts', 'e2e/helpers/removeTempDir.ts'],
    rules: {
      'no-restricted-syntax': noComputedRecursiveDelete,
    },
  },
  {
    // e2e specs name colours to assert on what is drawn.
    files: ['e2e/**/*.ts'],
    rules: {
      'pixel-agents/no-inline-colors': 'off',
    },
  },
  eslintConfigPrettier,
];
