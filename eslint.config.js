import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle-migration/**'],
  },

  // Base configuration for all TypeScript & JavaScript files
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    rules: {
      // Allow deliberately unused bindings when prefixed with `_`, e.g. params
      // kept to satisfy a public signature, or ignored destructured fields.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Node.js specific packages (CLI, Plugin, Plugin-Default, Runner, Store)
  {
    files: [
      'packages/rawbox-cli/**/*.{ts,js}',
      'packages/rawbox-plugin/**/*.{ts,js}',
      'packages/rawbox-plugin-default/**/*.{ts,js}',
      'packages/rawbox-runner/**/*.{ts,js}',
      'packages/rawbox-store/**/*.{ts,js}',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
