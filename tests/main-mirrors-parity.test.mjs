// The renderer's copies of main-process constants (src/main-mirrors.ts) stay
// equal to the electron values they mirror.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as mirrors from "../dist-test/main-mirrors.js";
import * as localSummary from "../dist-electron/local-summary-errors.js";
import * as validation from "../dist-electron/validation.js";
import * as teams from "../dist-electron/team-definition.js";
import * as usageHook from "../dist-electron/usage-hook.js";
import * as usageGrok from "../dist-electron/usage-grok.js";
import { TeamRunner } from "../dist-electron/team-runner.js";
import { TeamStore, teamDir } from "../dist-electron/team-store.js";
import { teamChat } from "../dist-test/team-chat.js";
import { teamProject } from "./helpers/team.mjs";

test("the renderer summarizes the same number of trailing lines as main", () => {
  assert.equal(mirrors.LOCAL_SUMMARY_MAX_LINES, 30);
  assert.equal(mirrors.LOCAL_SUMMARY_MAX_LINES, localSummary.LOCAL_SUMMARY_MAX_LINES);
});

test("the renderer writes the project-state version main validates", () => {
  assert.equal(mirrors.PROJECT_STATE_VERSION, 1);
  assert.equal(mirrors.PROJECT_STATE_VERSION, validation.PROJECT_STATE_VERSION);
});

test("the renderer's cadence ceiling is the one main's team parser enforces", () => {
  assert.equal(mirrors.MAX_CADENCE_MINUTES, 24 * 60);
  assert.equal(mirrors.MAX_CADENCE_MINUTES, teams.MAX_CADENCE_MINUTES);
});

test("the usage-chip dialog's throttle is the generated hook script's", () => {
  assert.equal(mirrors.HOOK_THROTTLE_MINUTES, 5);
  assert.equal(mirrors.HOOK_THROTTLE_MINUTES * 60, usageHook.HOOK_THROTTLE_SECONDS);
});

test("the Grok chip's day count is main's usage window", () => {
  assert.equal(mirrors.GROK_USAGE_WINDOW_DAYS, 7);
  assert.equal(mirrors.GROK_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000, usageGrok.GROK_USAGE_WINDOW_MS);
});

test("the Grok chip prices a tick as main documents it", () => {
  assert.equal(mirrors.USD_PER_GROK_TICK, 1e-10);
  assert.equal(mirrors.USD_PER_GROK_TICK, usageGrok.USD_PER_GROK_TICK);
});

test("the chat recognizes the delivery test main types and the word it asks back", async () => {
  assert.equal(mirrors.DELIVERY_TEST_PREFIX, "Delivery test:");
  assert.equal(mirrors.DELIVERY_TEST_ANSWER, "ok");
  const team = "# ux-review\n\n## Role: tester\nSends to: implementer\nMust not: edit code\n\n## Role: implementer\nSends to: tester\nMust not: skip a report\n";
  const { teamHome, project, cleanup } = teamProject("aya-mirrors-", { teamFile: team });
  try {
    const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
    await store.assign("tester", "pane-t");
    await store.assign("implementer", "pane-i");
    const deps = { teamHome, listProjects: async () => [project], deliver: async () => {}, holdReason: async () => null, headCommit: async () => null };
    await new TeamRunner(deps, () => () => {}, () => Date.now()).start("game", "ux-review");
    const tests = await store.log();
    assert.equal(tests.length, 2);
    for (const m of tests) {
      assert.ok(m.text.startsWith(mirrors.DELIVERY_TEST_PREFIX), m.text);
      assert.equal(/aya team send \S+ "([^"]+)"/.exec(m.text)?.[1], mirrors.DELIVERY_TEST_ANSWER, m.text);
    }
    const answer = (id, from, to) => ({ id, time: tests[0].time, from, to, commit: null, text: mirrors.DELIVERY_TEST_ANSWER, delivered: true });
    const chat = teamChat([...tests, answer(100, "tester", "implementer"), answer(101, "implementer", "tester")], ["tester", "implementer"]);
    assert.deepEqual(chat.map((e) => [e.kind, e.answered?.length]), [["delivery-test", 2]]);
  } finally {
    cleanup();
  }
});
