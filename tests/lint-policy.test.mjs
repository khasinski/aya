import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import a11y from '../scripts/eslint-a11y.mjs';

test('accessibility lint catches missing image names and inaccessible adjustable separators', () => {
  const linter = new Linter();
  const config = [{ languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } }, plugins: { a11y }, rules: { 'a11y/image-alt': 'error', 'a11y/focusable-separator': 'error', 'a11y/no-positive-tabindex': 'error' } }];
  const messages = linter.verify('const ui = <><img src="x"/><div role="separator" aria-valuenow={50}/><button tabIndex={3}>Go</button></>;', config);
  assert.deepEqual(messages.map(m => m.ruleId), ['a11y/image-alt', 'a11y/focusable-separator', 'a11y/no-positive-tabindex']);
  assert.equal(linter.verify('const ui = <><img src="x" alt=""/><div role="separator" aria-valuenow={50} aria-label="Resize" tabIndex={0}/></>;', config).length, 0);
});
