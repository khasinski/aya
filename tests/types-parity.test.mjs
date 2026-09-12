// The IPC contract is declared twice: src/types.ts (renderer) and
// electron/types.ts (main process). They are separate files on purpose -
// electron/ never imports from src/ - and the overlapping declarations are
// kept in sync by hand. Nothing checks that by itself: each TS project
// compiles against its OWN copy, so a field added on one side and forgotten
// on the other type-checks cleanly on both and only misbehaves at runtime,
// on the IPC boundary. This is the same reason split-tree-parity.test.mjs
// exists, applied to the types instead of the layout algebra.
//
// Member ORDER is deliberately not compared. TypeScript types are structural,
// so a reordered interface is the same type; the two copies of AyaApi already
// differ that way and it has never meant anything. Comparing printed text
// would fail on it and teach the next reader to ignore this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = "src/types.ts";
const MAIN = "electron/types.ts";

const printer = ts.createPrinter({ removeComments: true });

/** One declaration, reduced to what actually defines the type. `parts` is what
 *  gets compared: an interface contributes its members (sorted, so ordering
 *  can't fail the test), anything else contributes its whole printed form. */
function declarationShape(node, sourceFile) {
  const print = (n) =>
    printer.printNode(ts.EmitHint.Unspecified, n, sourceFile).replace(/\s+/g, " ").trim();
  return ts.isInterfaceDeclaration(node)
    ? node.members.map(print).sort()
    : [print(node)];
}

/** Every exported interface / type alias in a file, by name. */
function exportedTypes(relativePath) {
  const source = readFileSync(join(REPO, relativePath), "utf8");
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  const found = new Map();
  for (const statement of sourceFile.statements) {
    const isType =
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
    const isExported = statement.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (isType && isExported) {
      found.set(statement.name.text, declarationShape(statement, sourceFile));
    }
  }
  return found;
}

const renderer = exportedTypes(RENDERER);
const main = exportedTypes(MAIN);

// Guard the guard: every assertion below is "for each thing we found", so a
// parser that silently finds nothing would pass all of them.
test("types parity: both type files parse into declarations", () => {
  assert.ok(renderer.size > 0, `no exported types parsed out of ${RENDERER}`);
  assert.ok(main.size > 0, `no exported types parsed out of ${MAIN}`);
});

// Without this, renaming a type on one side only would quietly shrink the
// compared set and every remaining check would still pass.
test("types parity: every main-process type has a renderer counterpart", () => {
  const orphans = [...main.keys()].filter((name) => !renderer.has(name));
  assert.deepEqual(
    orphans,
    [],
    `${MAIN} declares types ${RENDERER} does not: ${orphans.join(", ")}. ` +
      `Either mirror them into the renderer copy, or - if they are genuinely ` +
      `main-process-only - move them out of ${MAIN} to the module that owns them.`,
  );
});

test("types parity: shared declarations are structurally identical", () => {
  const drifted = [];
  for (const [name, mainShape] of main) {
    const rendererShape = renderer.get(name);
    if (!rendererShape) continue; // reported by the orphan test above
    const only = (a, b) => a.filter((part) => !b.includes(part));
    const missingInMain = only(rendererShape, mainShape);
    const missingInRenderer = only(mainShape, rendererShape);
    if (missingInMain.length || missingInRenderer.length) {
      drifted.push(
        `${name}:\n` +
          `    only in ${RENDERER}: ${missingInMain.join(" | ") || "(nothing)"}\n` +
          `    only in ${MAIN}: ${missingInRenderer.join(" | ") || "(nothing)"}`,
      );
    }
  }
  assert.deepEqual(
    drifted,
    [],
    `the two copies of the IPC contract disagree:\n  ${drifted.join("\n  ")}`,
  );
});
