// The teams window tells Aya's own messages apart by their sender. The main
// process logs them under a literal (no exported constant yet), so both sides
// are pinned to that literal here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { AYA_SENDER, TEAM_LOG_VISIBLE } from "../dist-test/team-view.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => readFileSync(path.join(root, file), "utf8");

test("the renderer's name for Aya as a sender is the one the runner logs", () => {
  assert.equal(AYA_SENDER, "aya");
  assert.match(source("electron/team-runner.ts"), /from: "aya", to, text/);
  assert.match(source("electron/team-runner.ts"), /w\.from !== "aya"/);
  assert.match(source("electron/team-admin.ts"), /m\.from !== "aya"/);
});

test("the teams window shows the last 8 logged messages", () => {
  assert.equal(TEAM_LOG_VISIBLE, 8);
});
