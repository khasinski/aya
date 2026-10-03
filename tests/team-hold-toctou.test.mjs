// The hold is checked again before Enter (measured on real Claude: Enter on a pending permission dialog approved
// the tool call). A draft is Aya's own paste and does not stop it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { PaneHeldError } = await import("../dist-electron/team-control.js");

const SCREENS = {
  free: null,
  approval: "shows an approval prompt",
  numbered: "shows a numbered choice",
  draft: "has text the user is typing",
  shell: "runs a shell",
};
const WHEN = ["before the check", "after the check", "after the paste"];

let nextPane = 0;

/** A pane whose screen the test flips at a chosen point of the delivery. */
async function deliver(changeTo, when) {
  const pane = { screen: "free" };
  const events = [];
  const flip = (point) => {
    if (point === when) pane.screen = changeTo;
  };
  flip("before the check");
  const holdReason = async () => {
    events.push("hold");
    const hold = SCREENS[pane.screen];
    flip("after the check");
    return hold;
  };
  const write = async (_id, data) => {
    events.push(data === "\r" ? `enter on ${pane.screen}` : `paste on ${pane.screen}`);
    if (data !== "\r") flip("after the paste");
  };
  let held = null;
  await deliverTeamMessage(write, `hold-flip-${++nextPane}`, "hi", holdReason).catch((err) => {
    if (!(err instanceof PaneHeldError)) throw err;
    held = err.reason;
  });
  return { events, held };
}

const PROMPTS = ["approval", "numbered", "shell"];

// Each flip sequence owns its screen and delivery lock. Keep the within-case
// order, but overlap the real paste gap across independent panes.
describe("hold changes on independent panes", { concurrency: 8 }, () => {
  for (const changeTo of Object.keys(SCREENS).filter((s) => s !== "free")) {
    test(`screen becomes "${changeTo}" before the check: held, nothing typed`, async () => {
      const { events, held } = await deliver(changeTo, "before the check");
      assert.equal(held, SCREENS[changeTo]);
      assert.deepEqual(events, ["hold"]);
    });
  }

  for (const changeTo of PROMPTS) {
    test(`screen becomes "${changeTo}" after the check: the text lands, Enter is NOT sent, sender is told`, async () => {
      const { events, held } = await deliver(changeTo, "after the check");
      assert.match(held, /appeared after the text was typed; text left in the composer, Enter not sent/);
      assert.ok(held.includes(SCREENS[changeTo]), held);
      assert.deepEqual(events, ["hold", `paste on ${changeTo}`, "hold"]);
    });

    test(`screen becomes "${changeTo}" after the paste: Enter is NOT sent, sender is told`, async () => {
      const { events, held } = await deliver(changeTo, "after the paste");
      assert.match(held, /appeared after the text was typed; text left in the composer, Enter not sent/);
      assert.deepEqual(events, ["hold", "paste on free", "hold"]);
    });
  }

  test("a draft that appears after the check is Aya's own paste: Enter is still sent", async () => {
    for (const when of ["after the check", "after the paste"]) {
      const { events, held } = await deliver("draft", when);
      assert.equal(held, null, when);
      assert.equal(events.at(-1), `enter on draft`, when);
      assert.equal(events.filter((e) => e === "hold").length, 2, when);
    }
  });

  test("a free screen stays free through every point and is checked twice", async () => {
    for (const when of WHEN) {
      const { events } = await deliver("free", when);
      assert.deepEqual(events, ["hold", "paste on free", "hold", "enter on free"], when);
    }
  });

  test("only the check before Enter is told what was pasted; the one before the paste reads the raw screen", async () => {
    const calls = [];
    await deliverTeamMessage(async () => {}, `hold-flip-${++nextPane}`, "hello\nthere", async (_id, pasted) => void calls.push(pasted) ?? null);
    assert.deepEqual(calls, [undefined, "hello there"]);
  });
});
