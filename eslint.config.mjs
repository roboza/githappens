// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_ONLY = ['child_process', 'fs', 'fs/promises', 'path', 'os', 'net', 'crypto', 'electron'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'test/fixtures/.repos/**',
      'specs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-control-regex': 'off', // git output parsing uses NUL / control chars on purpose
    },
  },
  {
    // Spec 15 §7.3: the renderer never touches Node/Electron; everything goes through window.api.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...NODE_ONLY.flatMap((name) => [
              { name, message: 'Renderer code must use window.api (IPC), not Node/Electron APIs.' },
              { name: `node:${name}`, message: 'Renderer code must use window.api (IPC), not Node APIs.' },
            ]),
            { name: '@githappens/git', message: 'Import types from @githappens/git/types in the renderer.' },
          ],
          patterns: [
            { group: ['**/main/**', '**/preload/**'], message: 'Renderer may only import from shared/.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/test/**/*.ts', '**/e2e/**/*.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
