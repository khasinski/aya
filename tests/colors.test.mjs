// Pins the brand colors shared by TopBar and SettingsModal (and mirrored as
// --brand-claude / --brand-codex in app.css). One source of truth in TS; the
// CSS side cannot import it, so this pin is the tripwire when either changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../dist-test/colors.js";

test("brand colors are pinned", () => {
  assert.equal(CLAUDE_BRAND_COLOR, "#d97757");
  assert.equal(CODEX_BRAND_COLOR, "#10a37f");
});

test("app.css mirrors the TS brand colors (sync tripwire)", () => {
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/styles/app.css"),
    "utf8",
  );
  assert.ok(css.includes(`--brand-claude: ${CLAUDE_BRAND_COLOR};`));
  assert.ok(css.includes(`--brand-codex: ${CODEX_BRAND_COLOR};`));
});
