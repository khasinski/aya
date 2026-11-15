// Resolve re-exported declarations without constructing the entire application
// type graph. Both projects typecheck the canonical declarations independently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const files = new Map();
function source(file) {
  file = resolve(file);
  if (!files.has(file)) files.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true));
  return files.get(file);
}
function moduleFile(file, specifier) {
  const base = resolve(dirname(file), specifier);
  const candidates = [base, base + '.ts', base + '.d.ts', base.replace(/\.cjs$/, '.d.cts')];
  const found = candidates.find(existsSync);
  if (!found) throw Error(`Missing module: ${base}`);
  return found;
}
function declaration(file, name, visited = new Set()) {
  file = resolve(file);
  const key = file + ':' + name;
  if (visited.has(key)) return null;
  visited.add(key);
  for (const node of source(file).statements) {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === name) return { file, node };
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const item = node.exportClause.elements.find(item => item.name.text === name);
      if (item) {
        const local = (item.propertyName || item.name).text;
        if (node.moduleSpecifier) return declaration(moduleFile(file, node.moduleSpecifier.text), local, visited);
        for (const statement of source(file).statements) {
          if (!ts.isImportDeclaration(statement)) continue;
          const binding = statement.importClause?.namedBindings;
          if (!binding || !ts.isNamedImports(binding)) continue;
          const imported = binding.elements.find(item => item.name.text === local);
          if (imported) return declaration(moduleFile(file, statement.moduleSpecifier.text), (imported.propertyName || imported.name).text, visited);
        }
      }
    }
  }
  return null;
}
const shared = ['shared/ipc-types.d.ts', 'shared/project-team-types.d.ts'];

test('main and renderer use canonical wire declarations rather than maintaining copies', () => {
  for (const file of shared) for (const node of source(file).statements) {
    if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
    const name = node.name.text;
    const main = declaration('electron/types.ts', name), renderer = declaration('src/types.ts', name);
    if (!main || main.file !== resolve(file)) continue; // backend-only projections have their own owner
    assert.ok(renderer, `Renderer must export ${name}`);
    assert.equal(renderer.file, main.file, name);
    assert.ok(renderer.node === main.node, `${name} has distinct declarations`);
  }
});

test('core API, project, preset and team exports cannot drift back into copies', () => {
  for (const name of ['AyaApi', 'ProjectConfig', 'Preset', 'TeamDefinition', 'PtyEvent', 'GitChangedFile', 'UsageData']) {
    const a = declaration('src/types.ts', name), b = declaration('electron/types.ts', name);
    assert.ok(a && b, name);
    assert.ok(a.node === b.node, `${name} has distinct declarations`);
    assert.ok(a.file.includes('/shared/'), name);
  }
});
