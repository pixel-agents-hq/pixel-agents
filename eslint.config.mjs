import typescriptEslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
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
    files: ['adapters/vscode/constants.ts'],
    rules: {
      'pixel-agents/no-inline-colors': 'off',
    },
  },
  eslintConfigPrettier,
];
