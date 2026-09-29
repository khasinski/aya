import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/styles/overrides.css"),
  "utf8",
);

test(".aya-teams-warning is one rule with the danger color at 12px", () => {
  const rules = [...css.matchAll(/(^|\n)\.aya-teams-warning\s*\{([^}]*)\}/g)];
  assert.equal(rules.length, 1);
  const body = rules[0][2];
  assert.match(body, /color:\s*var\(--danger, #c0392b\);/);
  assert.match(body, /font-size:\s*12px;/);
  assert.match(body, /display:\s*flex;/);
  assert.match(body, /margin:\s*6px 0;/);
  assert.doesNotMatch(body, /--warn/);
});
