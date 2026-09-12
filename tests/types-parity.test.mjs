// The IPC contract is declared twice (src/types.ts, electron/types.ts) and kept
// in sync by hand: each project compiles against its OWN copy, so drift only
// misbehaves at runtime. Member ORDER is not compared - types are structural.

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

/** One declaration reduced to comparable parts: an interface contributes its
 *  members, its heritage and its type parameters (sorted), anything else its
 *  whole printed form. `node.members` alone would miss `extends`, and
 *  `WorktreeStatus extends Worktree` exists in both copies. */
function declarationShape(node, sourceFile) {
  const print = (n) =>
    printer.printNode(ts.EmitHint.Unspecified, n, sourceFile).replace(/\s+/g, " ").trim();
  if (!ts.isInterfaceDeclaration(node)) return [print(node)];
  // Tagged, so a heritage clause can never collide with a member of the same text.
  const head = [
    ...(node.typeParameters ?? []).map((n) => `<param> ${print(n)}`),
    ...(node.heritageClauses ?? []).map((n) => `<heritage> ${print(n)}`),
  ];
  return [...head, ...node.members.map(print)].sort();
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

// Every assertion below is "for each thing we found", so a parser that finds
// nothing would pass them all.
test("types parity: both type files parse into declarations", () => {
  assert.ok(renderer.size > 0, `no exported types parsed out of ${RENDERER}`);
  assert.ok(main.size > 0, `no exported types parsed out of ${MAIN}`);
});

// Without this, a one-sided rename shrinks the compared set and every remaining
// check still passes.
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
