// A report reserved for typing keeps the inbox's read mark before it: when the paste fails it is still owed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;

async function world() {
  const { teamHome, project, cleanup } = teamProject("aya-reserved-", { teamFile: TEAM });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  await store.setPaused(false);
  const deps = { teamHome, listProjects: async () => [project], deliver: async () => {}, holdReason: async () => null, headCommit: async () => null };
  const send = (text) => store.append({ from: "tester", to: "implementer", commit: null, text, delivered: false, held: "shows an approval prompt" });
  const inbox = () => handleTeamRequest({ type: "team-inbox" }, "pane-i", deps);
  return { store, send, inbox, cleanup };
}

const reservedTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const w = await world(...args);
    try {
      await fn(w);
    } finally {
      w.cleanup();
    }
  });
};

for (const ends of ["fails (released)", "succeeds (marked read)"]) {
  reservedTest(`inbox while report A is reserved for typing and a newer B is unread; the paste ${ends}`, async (w) => {
    const a = await w.send("report A: the benchmark");
    assert.equal(await w.store.beginTyping("implementer", a.id), true);
    await w.send("round B: later");
    const during = await w.inbox();
    assert.doesNotMatch(during.output, /report A/, "A is being typed, not handed over twice");
    if (ends.startsWith("fails")) {
      await w.store.endTyping("implementer");
      const after = await w.inbox();
      assert.match(after.output, /report A: the benchmark/, "A was not typed: the inbox still has it");
      assert.match(after.output, /round B: later/);
    } else {
      await w.store.markRead("implementer", a.id);
      await w.store.endTyping("implementer");
      const after = await w.inbox();
      assert.doesNotMatch(after.output, /report A/, "A was typed: not again");
      assert.match(after.output, /round B: later/, "B was not lost by the reservation");
    }
  });
}

// A reservation left by an Aya that went down mid-typing is not a typing in progress: the message counts as
// typed (not handed over again) and the inbox works, rather than staying empty for good.
for (const later of ["inbox", "redelivery of a newer message"]) {
  reservedTest(`a reservation left by a crash mid-typing; then the ${later}`, async (w) => {
    const a = await w.send("report A: typed when Aya went down");
    writeFileSync(path.join(w.store.dir, "typing.json"), JSON.stringify({ implementer: a.id }));
    await w.send("round B: after the relaunch");
    if (later === "inbox") {
      const out = (await w.inbox()).output;
      assert.doesNotMatch(out, /report A/, "A counts as typed");
      assert.match(out, /round B: after the relaunch/, "the inbox is not empty for good");
      assert.match((await w.inbox()).output, /no unread/);
    } else {
      const b = (await w.store.unread("implementer")).at(-1);
      assert.equal(await w.store.beginTyping("implementer", b.id), true);
      await w.store.endTyping("implementer");
      const out = (await w.inbox()).output;
      assert.doesNotMatch(out, /report A/);
      assert.match(out, /round B/, "B was not typed: still owed");
    }
  });
}

reservedTest("the other order: the inbox took report A first, then a redelivery may not reserve it", async (w) => {
  const a = await w.send("report A: the benchmark");
  assert.match((await w.inbox()).output, /report A/);
  assert.equal(await w.store.beginTyping("implementer", a.id), false, "not typed after the inbox handed it over");
  assert.match((await w.inbox()).output, /no unread/);
});

reservedTest("inbox with no reservation still hands over every unread message once", async (w) => {
  await w.send("one");
  await w.send("two");
  const out = (await w.inbox()).output;
  assert.match(out, /one/);
  assert.match(out, /two/);
  assert.match((await w.inbox()).output, /no unread/);
});
