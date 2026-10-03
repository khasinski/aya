// A message is reserved for typing (typing.json) before its paste waits for the receiver's pane lock; a reservation
// that never got the lock gives the message back to the next launch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { messageDeliveryText } from "../dist-test/team-view.js";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");

const TEAM = `# ux-review

## Role: lead
Sends to: worker (the next step)
Must not: edit code

## Role: worker
Sends to: lead (the result)
Must not: skip a report
`;
const TEXT = "report: the timer test fails on CI";

async function waitFor(cond) {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "timed out");
}

/** Aya sends the worker's report, quits where `quit` says, and a new Aya opens the same files. */
async function quitThenRelaunch(quit) {
  const t = teamProject("aya-resv-paste-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const first = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await first.assign("lead", "pane-l");
  await first.assign("worker", "pane-w");
  await first.setPaused(false);
  let began = false;
  const stuck = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    // The pane lock is never granted (another paste hangs there); "pasted" got it and began its paste.
    deliver: async (_pane, _text, _cancelled, _entered, pasting) => {
      if (quit === "after the paste began") await pasting?.();
      began = true;
      await new Promise(() => {});
    },
    headCommit: async () => null,
    holdReason: async () => null,
  };
  if (quit === "reservation from older code") {
    const entry = await first.append({ from: "worker", to: "lead", commit: null, text: TEXT, delivered: false });
    writeFileSync(join(first.dir, "typing.json"), JSON.stringify({ lead: entry.id }));
  } else {
    void handleTeamRequest({ type: "team-send", role: "lead", text: TEXT }, "pane-w", stuck);
    await waitFor(() => began && existsSync(join(first.dir, "typing.json")) && readFileSync(join(first.dir, "typing.json"), "utf-8").includes("lead"));
  }
  // The next launch: the same files under a new directory, so no reservation is this process's own.
  const relaunched = `${t.teamHome}-next`;
  cpSync(t.teamHome, relaunched, { recursive: true });
  const store = new TeamStore(teamDir(relaunched, "game", "ux-review"));
  const typed = [];
  const deps = { ...stuck, teamHome: relaunched, deliver: async (pane, text) => void typed.push({ pane, text }) };
  return { store, typed, deps, runner: new TeamRunner(deps, () => () => {}), cleanup: t.cleanup };
}

const relaunchTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const w = await quitThenRelaunch(...args);
    try {
      await fn(w);
    } finally {
      w.cleanup();
    }
  });
};

const QUITS = {
  "waiting for the pane lock": { owed: true, shown: "waiting in inbox" },
  "after the paste began": { owed: false, shown: "Aya went down while typing" },
  "reservation from older code": { owed: false, shown: "Aya went down while typing" },
};

for (const [quit, want] of Object.entries(QUITS)) {
  relaunchTest(`quit ${quit} | the next launch's inbox -> ${want.owed ? "the report is there" : "not there (it may be in the composer)"}`, quit, async (w) => {
    const { output } = await handleTeamRequest({ type: "team-inbox" }, "pane-l", w.deps);
    assert.equal(output.includes(TEXT), want.owed);
  });

  relaunchTest(`quit ${quit} | the next launch's redelivery -> ${want.owed ? "types the report once" : "types nothing"}`, quit, async (w) => {
    await w.runner.redeliverWaiting();
    await w.runner.redeliverWaiting();
    assert.equal(w.typed.filter((x) => x.pane === "pane-l" && x.text.includes(TEXT)).length, want.owed ? 1 : 0);
  });

  relaunchTest(`quit ${quit} | the next launch's window -> ${want.shown}`, quit, async (w) => {
    const [m] = (await w.store.annotatedLog()).filter((x) => x.text === TEXT);
    assert.match(messageDeliveryText(m) ?? "", new RegExp(want.shown));
  });
}

// main's deliver: the reservation is marked as pasting once the pane lock is held and no hold stops the paste.
const { deliverTeamMessage } = await import("../dist-electron/control.js");
const DELIVER_ROWS = [
  ["a free pane", null, ["pasting", "paste", "enter"]],
  ["a pane that shows an approval prompt", "shows an approval prompt", []],
];
for (const [label, hold, want] of DELIVER_ROWS) {
  test(`deliverTeamMessage | ${label} -> ${want.length ? "pasting is marked before the paste" : "pasting is never marked"}`, async () => {
    const seen = [];
    const write = async (_id, data) => (seen.push(data === "\r" ? "enter" : "paste"), true);
    await deliverTeamMessage(write, "pane-q", TEXT, async () => hold, undefined, undefined, undefined, async () => void seen.push("pasting")).catch(() => {});
    assert.deepEqual(seen, want);
  });
}
