// e2e/timeouts.ts keeps its own copies of the production periods its deadlines
// are built from; this pins each copy to its source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

import { TEAM_REDELIVERY_MS } from "../dist-electron/team-ipc.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** e2e/timeouts.ts is TypeScript with no imports: transpile and evaluate it. */
function loadE2eTimeouts() {
  const source = readFileSync(join(REPO, "e2e", "timeouts.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("module", "exports", outputText)(module, module.exports);
  return module.exports;
}

test("the e2e redelivery period is the one team-ipc retries held messages at", () => {
  const e2e = loadE2eTimeouts();
  assert.equal(e2e.TEAM_REDELIVERY_MS, TEAM_REDELIVERY_MS);
});
