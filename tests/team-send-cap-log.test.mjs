// A role that sends more than TEAM_SENDS_PER_MINUTE in a minute is refused, and the log gets one line per minute of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest, TEAM_SENDS_PER_MINUTE } = await import("../dist-electron/team-control.js");

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
  const t = teamProject("aya-cap-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  await store.setPaused(false);
  const deps = { teamHome: t.teamHome, listProjects: async () => [t.project], deliver: async () => {}, headCommit: async () => null, holdReason: async () => null };
  const send = (pane, role, text) => handleTeamRequest({ type: "team-send", role, text }, pane, deps).then((r) => r.output, (e) => e.message);
  return { ...t, store, send };
}

const refusals = async (store) => (await store.log()).filter((m) => m.from === "aya" && /refused/.test(m.text));

// attempts in one minute -> refusal lines in the log
const ROWS = [
  [TEAM_SENDS_PER_MINUTE, 0],
  [TEAM_SENDS_PER_MINUTE + 1, 1],
  [TEAM_SENDS_PER_MINUTE + 5, 1],
];
for (const [attempts, lines] of ROWS) {
  test(`${attempts} sends in a minute: ${lines} refusal line(s) in the log, and the refused text is not logged as sent`, async () => {
    const t = await setup();
    try {
      const outputs = [];
      for (let i = 0; i < attempts; i++) outputs.push(await t.send("pane-l", "worker", `step ${i}`));
      const found = await refusals(t.store);
      assert.equal(found.length, lines);
      assert.equal((await t.store.log()).filter((m) => m.from === "lead").length, TEAM_SENDS_PER_MINUTE, "only the allowed ones are in the log as the lead's");
      if (lines) {
        assert.match(found[0].text, new RegExp(`^lead's message to worker was refused: ${TEAM_SENDS_PER_MINUTE} messages in the last minute`));
        assert.equal(found[0].to, "lead");
        assert.equal(found[0].delivered, true, "a record for the window, not a message anyone owes");
        assert.deepEqual(await t.store.unread("lead"), []);
        assert.match(outputs.at(-1), /sent 10 messages in the last minute; nothing was sent/);
      }
    } finally {
      t.cleanup();
    }
  });
}

test("the other role is counted on its own: its refusal is a second line", async () => {
  const t = await setup();
  try {
    for (let i = 0; i <= TEAM_SENDS_PER_MINUTE; i++) await t.send("pane-l", "worker", `step ${i}`);
    for (let i = 0; i <= TEAM_SENDS_PER_MINUTE; i++) await t.send("pane-w", "lead", `result ${i}`);
    const found = await refusals(t.store);
    assert.deepEqual(found.map((m) => m.to).sort(), ["lead", "worker"]);
  } finally {
    t.cleanup();
  }
});
