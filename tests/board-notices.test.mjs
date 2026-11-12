import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createBoardNotices, pendingBoardNotices, acknowledgeBoardNotice, createBoardInputProtection } = await import("../dist-electron/board-notices.js");
const { sendPaneTextThroughControl } = await import("../dist-electron/control.js");
const { TextPastedError } = await import("../dist-electron/team-control.js");
const { HOLD_NOT_RUNNING } = await import("../dist-electron/pane-holds.js");
const { HOLD_STARTING, HOLD_DRAFT, HOLD_APPROVAL, HOLD_CHOICE, HOLD_ACCOUNT_SETTING, HOLD_USAGE_LIMIT, HOLD_SHELL, HOLD_RECOVERY_UNKNOWN, HOLD_BUSY } = await import("../dist-electron/pane-holds.js");

function fixture(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "aya-board-notices-"));
  let owner, error, attempts = 0;
  const deps = {
    home, currentOwner: async () => owner, paneOpen: async () => true,
    changed: () => {}, send: async () => { attempts++; if (error) throw error; }, ...overrides,
  };
  let notices = createBoardNotices(deps);
  t.after(() => { notices.stop(); rmSync(home, { recursive: true, force: true }); });
  return {
    home, notices: () => notices, owner: value => { owner = value; }, error: value => { error = value; }, attempts: () => attempts,
    restart() { notices.stop(); notices = createBoardNotices(deps); },
    enqueue: projectSlug => notices.enqueue({ projectSlug, cardId: "t-1", paneId: "pane-1", paneName: "Agent", title: "Task", reason: "returned to Todo" }),
  };
}

test("partially pasted notices remain visible after reassignment until the user acknowledges them", async t => {
  const fx = fixture(t);
  await fx.enqueue("demo");
  fx.error(new TextPastedError("pasted, Enter blocked"));
  await fx.notices().flush();
  assert.equal((await pendingBoardNotices(fx.home, "demo"))[0].state, "typed");
  fx.owner("pane-1");
  fx.restart();
  await fx.notices().flush();
  const pending = await pendingBoardNotices(fx.home, "demo");
  assert.equal(pending.length, 1, "reassignment must not hide text still left in the composer");
  await acknowledgeBoardNotice(fx.home, "other-project", pending[0].id);
  assert.equal((await pendingBoardNotices(fx.home, "demo")).length, 1);
  await acknowledgeBoardNotice(fx.home, "demo", pending[0].id);
  assert.equal((await pendingBoardNotices(fx.home, "demo")).length, 0);
  assert.equal(fx.attempts(), 1);
});

test("an unreadable board does not prevent another project's notices from being delivered", async t => {
  t.mock.method(console, "warn", () => {});
  const fx = fixture(t, { currentOwner: async notice => { if (notice.projectSlug === "bad") throw new Error("broken board"); } });
  await fx.enqueue("bad");
  await fx.enqueue("good");
  await fx.notices().flush();
  assert.equal((await pendingBoardNotices(fx.home, "bad")).length, 1);
  assert.equal((await pendingBoardNotices(fx.home, "good")).length, 0);
  assert.equal(fx.attempts(), 1);
});

test("accepted app shutdown retains notices while the old pane controller is being disposed", async t => {
  const fx = fixture(t, { deliveryAllowed: () => false, paneHold: async () => HOLD_NOT_RUNNING });
  await fx.enqueue("demo");
  await fx.notices().flush();
  assert.equal((await pendingBoardNotices(fx.home, "demo")).length, 1);
  assert.equal(fx.attempts(), 0);
});

test("a not-yet-attached pane retains its notice and receives it after attachment", async t => {
  let attached = false;
  const fx = fixture(t, { paneHold: async () => attached ? null : HOLD_NOT_RUNNING });
  await fx.enqueue("demo");
  await fx.notices().flush();
  assert.equal((await pendingBoardNotices(fx.home, "demo")).length, 1);
  attached = true;
  await fx.notices().flush();
  assert.equal(fx.attempts(), 1);
  assert.equal((await pendingBoardNotices(fx.home, "demo")).length, 0);
});

test("lost input acknowledgement is uncertain and cannot be pasted again", async t => {
  const fx = fixture(t);
  await fx.enqueue("demo");
  fx.error(Object.assign(new Error("Some bytes may have reached the process"), { code: "PTY_HOST_INPUT_UNCERTAIN" }));
  await fx.notices().flush();
  assert.equal((await pendingBoardNotices(fx.home, "demo"))[0].state, "typed");
  await fx.notices().flush();
  assert.equal(fx.attempts(), 1);
});

for (const initialHold of [HOLD_STARTING, HOLD_DRAFT, HOLD_APPROVAL, HOLD_CHOICE, HOLD_ACCOUNT_SETTING, HOLD_USAGE_LIMIT, HOLD_SHELL, HOLD_RECOVERY_UNKNOWN]) {
  test(`automatic withdrawal waits while its pane ${initialHold}`, async t => {
    let hold = initialHold;
    const fx = fixture(t, { paneHold: async () => hold });
    await fx.enqueue("demo");
    await fx.notices().flush();
    assert.equal(fx.attempts(), 0, "must not type into a launcher, dialog, shell or user draft");
    assert.equal((await pendingBoardNotices(fx.home, "demo")).length, 1);
    hold = null;
    await fx.notices().flush();
    assert.equal(fx.attempts(), 1);
  });
}

test("a busy agent can receive a stop message without waiting for its work to finish", async t => {
  const fx = fixture(t, { paneHold: async () => HOLD_BUSY });
  await fx.enqueue("demo");
  await fx.notices().flush();
  assert.equal(fx.attempts(), 1);
});

function protectedDelivery(automatic, holdReason) {
  const bytes = [];
  return { bytes, send: () => sendPaneTextThroughControl({
    listProjects: async () => [{ slug: "demo", name: "Demo", directory: "/repo", tabs: [{ id: "pane-1", name: "Agent", presetId: "claude" }] }],
    writePane: async (_id, data) => { bytes.push(data); },
    paneInputProtection: createBoardInputProtection(automatic, holdReason, async () => null),
  }, "demo", "pane-1", "withdraw t-1") };
}

test("the real input lock refuses an automatic notice before paste when startup begins", async () => {
  const delivery = protectedDelivery(true, async () => HOLD_STARTING);
  await assert.rejects(delivery.send(), /starting/);
  assert.deepEqual(delivery.bytes, []);
});

test("the real Enter boundary leaves a partial notice unsubmitted if a draft appears", async () => {
  const delivery = protectedDelivery(true, async (_id, pasted) => pasted ? HOLD_DRAFT : null);
  await assert.rejects(delivery.send(), error => error.typed === true);
  assert.ok(delivery.bytes.join("").includes("withdraw t-1"));
  assert.ok(!delivery.bytes.includes("\r"), "Enter must not be sent after the hold changes");
});

test("explicit user delivery keeps its existing protection path", async () => {
  const delivery = protectedDelivery(false, async () => { throw new Error("automatic-only protection should not run"); });
  await delivery.send();
  assert.ok(delivery.bytes.includes("\r"));
});
