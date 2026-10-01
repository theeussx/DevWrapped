// ESLint flat configuration.
// Type-aware linting is enabled for the extension sources so that unsafe
// async patterns, floating promises and implicit `any` values are caught
// before they reach a release.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const restrictedNodeImports = [
  'node:child_process',
  'child_process',
  'node:http',
  'http',
  'node:https',
  'https',
  'node:net',
  'net',
  'node:dgram',
  'dgram',
  'node:tls',
  'tls',
];

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '.vscode-test/**', 'media/icon.png'],
  },

  // Extension sources and tests: type-aware rules.
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: restrictedNodeImports.map((name) => ({
            name,
            message:
              'Dev Wrapped must stay offline and must never spawn processes. See docs: Security model.',
          })),
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Dev Wrapped never performs network requests.' },
      ],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'curly': ['error', 'multi-line'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-eval': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Webview client script (plain browser JavaScript, ships in the VSIX).
  // Test files: `node:test` returns a promise from every `test()` call, and the
  // runner owns that promise, so it is not a floating promise.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },

  {
    files: ['media/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        Intl: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // Repository tooling scripts (Node ESM, not shipped).
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  }
);
