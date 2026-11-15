import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import a11y from './scripts/eslint-a11y.mjs';

export default [
  { ignores: ["**/*.d.ts"] },
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, project: ['./tsconfig.json', './electron/tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      'no-async-promise-executor': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'aya-a11y': a11y },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'aya-a11y/image-alt': 'error',
      'aya-a11y/focusable-separator': 'error',
      'aya-a11y/no-positive-tabindex': 'error',
    },
  },
];
