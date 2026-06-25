import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("Codex dashed internal-link underlines render as normal links", () => {
  const css = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src/styles/overrides.css",
    ),
    "utf8",
  );

  assert.match(css, /\.aya-xterm-frame\s+\.xterm-underline-5\s*\{/);
  assert.match(css, /text-decoration:\s*underline\s*!important;/);
});
