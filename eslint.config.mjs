// ESLint: correctness rules only. How the code looks is Prettier's job (npm run format), so the
// rules that would argue with it are switched off by eslint-config-prettier, last in the list.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '.vscode-test/', 'media/', 'sound-candidates/', 'personal-sounds/', 'test/fixtures/', 'docs/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The extension host, the converter and the tests run in Node.
    files: ['src/**/*.ts', 'test/**/*.ts', '*.config.mts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The viewer runs in a webview (a browser page).
    files: ['webview/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Build and maintenance scripts.
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  prettier,
);
