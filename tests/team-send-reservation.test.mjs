// Every typing path takes the same reservation: the message is in the log before its paste, and a paste Aya went
// down in the middle of is counted as typed (never typed twice) and shown as maybe sitting in the composer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;

async function setup() {
  const t = teamProject("aya-send-reserve-", { teamFile: TEAM });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const typed = [];
  const deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async () => null,
    headCommit: async () => null,
  };
  return { ...t, store, typed, deps };
}

const DIST = resolve("dist-electron");

const CRASHES = {
  "aya team send": `
    const { handleTeamRequest } = require(${JSON.stringify(`${DIST}/team-control.js`)});
    handleTeamRequest({ type: "team-send", role: "implementer", text: "found a bug" }, "pane-t", deps);`,
  redelivery: `
    const { TeamStore, teamDir } = require(${JSON.stringify(`${DIST}/team-store.js`)});
    const { TeamRunner } = require(${JSON.stringify(`${DIST}/team-runner.js`)});
    new TeamStore(teamDir(deps.teamHome, "game", "ux-review"))
      .append({ from: "tester", to: "implementer", commit: null, text: "found a bug", delivered: false })
      .then(() => new TeamRunner(deps, () => () => {}).redeliverWaiting());`,
  "the Start's task": `
    const { TeamRunner } = require(${JSON.stringify(`${DIST}/team-runner.js`)});
    const typeTests = deps.deliver;
    deps.deliver = async (pane, text, ...rest) => (/found a bug/.test(text) ? typeTests(pane, text, ...rest) : undefined);
    new TeamRunner(deps, () => () => {}).start("game", "ux-review", { text: "found a bug", to: "implementer" });`,
};

/** A second process stands for the Aya that went down: it runs `body` and exits in the middle of the paste. */
function crashMidPaste(t, body) {
  const script = `
    const project = ${JSON.stringify(t.project)};
    const deps = {
      teamHome: ${JSON.stringify(t.teamHome)},
      listProjects: async () => [project],
      deliver: async (_pane, _text, _cancelled, _entered, pasting) => (await pasting?.(), process.exit(7)),
      holdReason: async () => null,
      headCommit: async () => null,
    };
    ${body}`;
  assert.throws(() => execFileSync(process.execPath, ["-e", script], { stdio: "pipe" }), (err) => err.status === 7);
}

for (const [path, body] of Object.entries(CRASHES)) {
  test(`Aya goes down in the middle of a paste (${path}): the message is logged, counted as typed and not typed again`, async () => {
    const t = await setup();
    try {
      crashMidPaste(t, body);
      const next = new TeamRunner(t.deps, () => () => {});
      await next.restore();
      assert.equal(await next.redeliverWaiting(), 0, "the next Aya does not type it again");
      assert.equal(t.typed.filter((w) => /found a bug/.test(w.text)).length, 0);
      const [message] = (await t.store.annotatedLog()).filter((m) => /found a bug/.test(m.text));
      assert.ok(message, "the message is in the log");
      assert.equal(message.delivered, true);
      assert.equal(message.typedOnly, true);
      assert.match(message.held ?? "", /Aya went down while typing it/);
    } finally {
      t.cleanup();
    }
  });
}

test("a send whose log entry cannot be written types nothing", async () => {
  const t = await setup();
  const realAppend = TeamStore.prototype.append;
  TeamStore.prototype.append = () => Promise.reject(new Error("disk full"));
  try {
    await assert.rejects(handleTeamRequest({ type: "team-send", role: "implementer", text: "found a bug" }, "pane-t", t.deps), /disk full/);
    assert.equal(t.typed.length, 0, "nothing reached the pane");
  } finally {
    TeamStore.prototype.append = realAppend;
    t.cleanup();
  }
});

// The reservation a crash left stays in typing.json until that role's next typing folds it; the next Aya's clock
// must not read it as a paste still in flight.
test("a reservation a crash left | a look of the clock still hears the messages after it", async () => {
  const { observe } = await import("../dist-electron/team-progress.js");
  const t = await setup();
  try {
    crashMidPaste(t, CRASHES["aya team send"]);
    await handleTeamRequest({ type: "team-send", role: "tester", text: "fixed in abc1234" }, "pane-i", t.deps);
    assert.equal(t.typed.length, 1, "the reply was typed");
    const progress = await observe(t.store, null, {}, new Date().toISOString());
    // The crashed one may sit in the composer without its Enter: typed only, not talk.
    assert.equal(progress.messages, 1, "the reply after the crashed message is heard");
  } finally {
    t.cleanup();
  }
});

// The Start's task and a redelivery pass both see one message owed: whichever reserves it first types it.
test("overlapping typing paths | a redelivery pasting the Start's task while the Start goes on: typed once", async () => {
  const t = await setup();
  const latch = () => {
    let open;
    const opened = new Promise((resolve) => (open = resolve));
    return { opened, open };
  };
  const startAtPane = latch();
  const startGo = latch();
  const redeliveryPasting = latch();
  const redeliveryGo = latch();
  let held = false;
  const pastes = [];
  const runner = new TeamRunner(
    {
      ...t.deps,
      // The Start stops at its pane check, with its task already in the log, until the redelivery is mid-paste.
      holdReason: async (pane) => {
        if (pane === "pane-i" && !held && (await t.store.log()).some((m) => /fix the parser/.test(m.text))) {
          held = true;
          startAtPane.open();
          await startGo.opened;
        }
        return null;
      },
      deliver: async (pane, text) => {
        pastes.push(text);
        if (/fix the parser/.test(text) && pastes.filter((p) => /fix the parser/.test(p)).length === 1) {
          redeliveryPasting.open();
          await redeliveryGo.opened;
        }
      },
    },
    () => () => {},
  );
  try {
    const start = runner.start("game", "ux-review", { text: "fix the parser", to: "implementer" });
    await startAtPane.opened;
    const redelivery = runner.redeliverWaiting();
    await redeliveryPasting.opened;
    startGo.open();
    await start;
    redeliveryGo.open();
    await redelivery;
    assert.equal(pastes.filter((p) => /fix the parser/.test(p)).length, 1, `typed once: ${JSON.stringify(pastes)}`);
  } finally {
    runner.stopAll();
    t.cleanup();
  }
});
