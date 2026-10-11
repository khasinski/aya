// Pause while Aya is pasting a round: the paste cannot be taken back, so the Enter is withheld, as when a prompt
// appears in between, and the log says so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { PaneHeldError } = await import("../dist-electron/team-control.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { TEAM_MINUTE_MS } = await import("../dist-electron/paths.js");

// [label, when the team is cancelled, writes the pane gets]
const WRITE_ROWS = [
  ["never cancelled", null, ["paste", "enter"]],
  ["a cancel check that stays false", "never", ["paste", "enter"]],
  ["cancelled after the paste, before Enter", "after paste", ["paste"]],
];
for (const [label, when, expected] of WRITE_ROWS) {
  test(`deliverTeamMessage | ${label}`, async () => {
    const writes = [];
    let pasted = false;
    const write = async (_id, data) => void (writes.push(data === "\r" ? "enter" : "paste"), (pasted = true));
    const cancelled = when === "after paste" ? () => pasted : () => false;
    const result = await deliverTeamMessage(write, "pane-1", "Round 3: go", async () => null, cancelled).then(() => null, (e) => e);
    assert.deepEqual(writes, expected);
    if (when === "after paste") {
      assert.ok(result instanceof PaneHeldError);
      assert.equal(result.typed, true, "the text is in the composer");
      assert.match(result.reason, /paused or changed while it was typed; text left in the composer, Enter not sent/);
    } else assert.equal(result, null);
  });
}

const TEAM = `# ux-review

## Role: lead
Sends to: worker (the next step)
Must not: edit code

## Role: worker
Sends to: lead (the result)
Must not: skip a report

## Lead
lead

## Cadence
lead every 30 min
`;

test("a Pause that lands while the round is being typed: the Enter is not sent and the log says it was left in the composer", async () => {
  const t = teamProject("aya-midpaste-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  try {
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
    await store.assign("lead", "pane-l");
    await store.assign("worker", "pane-w");
    await store.setPaused(false);
    const jobs = [];
    const writes = [];
    let runner;
    let pauseNow = null;
    const deps = {
      teamHome: t.teamHome,
      listProjects: async () => [t.project],
      // The paste goes in, then the user clicks Pause, then the Enter would follow.
      deliver: async (pane, text, cancelled) => {
        if (pane === "pane-l" && /Aya round \d+:/.test(text)) {
          writes.push("paste");
          await pauseNow?.();
          if (cancelled?.()) throw new PaneHeldError("the team was paused or changed while it was typed; text left in the composer, Enter not sent", true);
          writes.push("enter");
          return;
        }
      },
      headCommit: async () => null,
      holdReason: async () => null,
    };
    let clock = Date.now();
    runner = new TeamRunner(deps, (fn) => (jobs.push(fn), () => {}), () => clock);
    pauseNow = () => runner.pause("game", "ux-review");
    await runner.resume("game", "ux-review");
    clock += 30 * TEAM_MINUTE_MS;
    await jobs.at(-1)();
    assert.deepEqual(writes, ["paste"], "the Enter was not sent after the Pause");
    const entry = (await store.log()).filter((m) => m.from === "aya" && m.to === "lead").at(-1);
    assert.equal(entry.typedOnly, true);
    assert.match(entry.held, /paused or changed while it was typed/);
    assert.equal(await store.lastRound(), 0, "a round that was not submitted does not use up a number");
  } finally {
    t.cleanup();
  }
});
