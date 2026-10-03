// A report typed into the composer with its Enter withheld has not reached the agent: it ends no silence or stall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { observe, resetProgress, teamLiveness } = await import("../dist-electron/team-progress.js");
const { STALL_AFTER_MS } = await import("../dist-electron/team-times.js");

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const TEAM = `# ux-review

## Role: lead
Sends to: worker (the next step)
Must not: edit code

## Role: worker
Sends to: lead (the result)
Must not: skip a report

## Lead
lead
`;

async function setup() {
  const t = teamProject("aya-typed-only-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  await store.setPaused(false);
  await resetProgress(store, null, iso(NOW - 10 * 60_000));
  return { ...t, store };
}
const report = (over) => ({ from: "worker", to: "lead", commit: null, text: "report: the build is green and the timer test passes", delivered: true, ...over });

// [label, entries, moved]
const ROWS = [
  ["a report that was typed and submitted", [report({})], true],
  ["a report typed with its Enter withheld", [report({ typedOnly: true, held: "shows an approval prompt" })], false],
  ["a report still waiting in the inbox", [report({ delivered: false, held: "shows an approval prompt" })], false],
  ["an ack", [report({ text: "ok" })], false],
  ["a withheld report, then one that went in", [report({ typedOnly: true, held: "shows an approval prompt" }), report({ text: "report: second try, all green" })], true],
];
// The clock's look (observe) is the only writer; the window reads, so a refresh moves nothing.
for (const [label, entries, moved] of ROWS) {
  for (const how of ["the clock's look", "window refresh"]) {
    test(`progress | ${label} | ${how}`, async () => {
      const t = await setup();
      try {
        for (const e of entries) await t.store.append(e);
        const now = iso(NOW);
        const before = (await t.store.progress()).changedAt;
        if (how === "the clock's look") await observe(t.store, null, {}, now);
        else await teamLiveness(t.store, ["lead", "worker"], async () => null, { cadence: null, lead: true }, NOW);
        const after = (await t.store.progress()).changedAt;
        // The log's own entry time is "now" on this machine; progress moves the clock to it (or leaves it at the Start).
        assert.equal(after !== before, moved && how === "the clock's look", `changedAt ${before} -> ${after}`);
      } finally {
        t.cleanup();
      }
    });
  }
}

// A withheld report is not even talk.
test("a stalled team stays stalled, and silent, while the only report is withheld", async () => {
  const t = await setup();
  try {
    const later = NOW + STALL_AFTER_MS;
    await t.store.append(report({ typedOnly: true, held: "shows an approval prompt" }));
    await observe(t.store, null, {}, iso(later));
    const live = await teamLiveness(t.store, ["lead", "worker"], async () => null, { cadence: null, lead: true }, later);
    assert.equal(live.status, "stalled");
    assert.equal(live.repo.messages, 0);
  } finally {
    t.cleanup();
  }
});
