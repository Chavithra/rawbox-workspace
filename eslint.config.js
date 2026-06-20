import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
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
  },

  // Node.js specific packages (CLI, Server, Plugin, Store, Runner)
  {
    files: [
      'packages/rawbox-cli/**/*.{ts,js}',
      'packages/rawbox-default-plugins/**/*.{ts,js}',
      'packages/rawbox-plugin/**/*.{ts,js}',
      'packages/rawbox-runner/**/*.{ts,js}',
      'packages/rawbox-server/**/*.{ts,js}',
      'packages/rawbox-store/**/*.{ts,js}',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // React/Browser specific package (rawbox-client)
  {
    files: ['packages/rawbox-client/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
);
