// An agent's question is `aya status waiting` run by the agent; Aya's own hooks (AYA_VIA=hook) report turns and
// never end it (PostToolUse fires right after that very call). A CLI dialog is read from the screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-waiting-home-"));

const { recordAgentStatus, agentWaitingSince, noteUserAnswer } = await import("../dist-electron/agent-status.js");
const { startControlServerOn } = await import("../dist-electron/control.js");
const { HOLD_APPROVAL, HOLD_APPROVE_AYA, HOLD_CHOICE, HOLD_DRAFT, HOLD_NOT_RUNNING } = await import("../dist-electron/pane-holds.js");

const HOOK = "hook";
const QUESTION = ["waiting", "need the staging password"];

// [label, the pane's status before (null: none; QUESTION: the agent asked), level, via, question after, what the windows get]
const ROWS = [
  ["no status, hook Notification", null, "waiting", HOOK, false, "done"],
  ["no status, hook PostToolUse", null, "active", HOOK, false, "active"],
  ["no status, hook Stop", null, "done", HOOK, false, "done"],
  ["no status, the agent asks", null, "waiting", undefined, true, "waiting"],
  ["agent done, hook Notification (idle composer)", ["done", "Turn finished"], "waiting", HOOK, false, "done"],
  ["question, hook Notification", QUESTION, "waiting", HOOK, true, null],
  ["question, hook PostToolUse (the aya status call itself)", QUESTION, "active", HOOK, true, null],
  ["question, hook Stop (the turn that asked ends)", QUESTION, "done", HOOK, true, null],
  ["question, the agent says active", QUESTION, "active", undefined, false, "active"],
  ["question, the agent says done", QUESTION, "done", undefined, false, "done"],
  ["question, the agent clears it", QUESTION, "clear", undefined, false, "clear"],
  ["question, the agent asks again", QUESTION, "waiting", undefined, true, "waiting"],
];

for (const [label, before, level, via, asked, windows] of ROWS) {
  test(`status source | ${label}`, () => {
    const pane = `pane-${label}`;
    if (before) recordAgentStatus(pane, before[0], 1000, before[1]);
    const update = recordAgentStatus(pane, level, 5000, "x", via);
    assert.equal(update?.level ?? null, windows, "what the windows are told");
    const since = agentWaitingSince(pane);
    assert.equal(since !== null, asked, "an outstanding question to the user");
    if (asked) assert.equal(since, before && via === HOOK ? 1000 : 5000, "since the agent asked");
  });
}

// [label, the pane's screen when the user presses Enter, the question ends]
const ENTER = [
  ["Enter on the composer", null, true],
  ["Enter on a draft", HOLD_DRAFT, true],
  ["Enter in a permission dialog", HOLD_APPROVAL, false],
  ["Enter in a numbered choice", HOLD_CHOICE, false],
  ["Enter approving an aya command", HOLD_APPROVE_AYA, false],
  ["Enter in a pane the host cannot read", HOLD_NOT_RUNNING, true],
];
for (const [label, hold, answered] of ENTER) {
  test(`the user's Enter | question, ${label}`, async () => {
    const pane = `enter-${label}`;
    recordAgentStatus(pane, ...QUESTION.slice(0, 1), 1000, QUESTION[1]);
    const update = await noteUserAnswer(pane, "\r", async () => hold, 5000);
    assert.equal(update !== null, answered);
    assert.equal(agentWaitingSince(pane), answered ? null : 1000);
  });
}

test("the user's Enter | no question: the screen is not even read", async () => {
  let read = 0;
  assert.equal(await noteUserAnswer("enter-none", "\r", async () => (read++, null), 5000), null);
  assert.equal(read, 0, "no host round trip for a pane that asked nothing");
});

test("the user's Enter | a dialog answered, then Enter on the composer: the question ends then", async () => {
  recordAgentStatus("enter-two", "waiting", 1000, "which db?");
  assert.equal(await noteUserAnswer("enter-two", "\r", async () => HOLD_APPROVAL, 2000), null);
  assert.equal(agentWaitingSince("enter-two"), 1000);
  assert.deepEqual(await noteUserAnswer("enter-two", "postgres\r", async () => null, 3000), { terminalId: "enter-two", level: "clear", updatedAt: 3000 });
  assert.equal(agentWaitingSince("enter-two"), null);
});

async function viaServer(frames) {
  const dir = mkdtempSync(join(tmpdir(), "aya-waiting-sock-"));
  const socketPath = join(dir, "c.sock");
  const sent = [];
  const stop = startControlServerOn(socketPath, {
    getWindow: () => null,
    getWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, update) => sent.push([channel, update]) } }],
  });
  try {
    for (const frame of frames) {
      await new Promise((resolve, reject) => {
        const c = net.createConnection(socketPath, () => c.end(`${JSON.stringify(frame)}\n`));
        c.on("data", () => {});
        c.on("close", resolve);
        c.on("error", reject);
      });
    }
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
  return sent.map(([, update]) => [update.level, update.text]);
}

const status = (level, text, via) => ({ type: "status", level, text, terminalId: "srv-lead", caller: { terminalId: "srv-lead", ...(via ? { via } : {}) } });

test("control server | the hook's Notification is a finished turn: no question, the windows hear done", async () => {
  const sent = await viaServer([status("waiting", "Waiting for your next prompt", HOOK)]);
  assert.deepEqual(sent, [["done", "Waiting for your next prompt"]]);
  assert.equal(agentWaitingSince("srv-lead"), null);
});

test("control server | aya status waiting, then the hooks of that turn: the question stays, the windows hear only it", async () => {
  const sent = await viaServer([
    status("waiting", "need the staging password"),
    status("active", "running Bash", HOOK),
    status("done", "Turn finished", HOOK),
    status("waiting", "Claude is waiting for your input", HOOK),
  ]);
  assert.deepEqual(sent, [["waiting", "need the staging password"]]);
  assert.notEqual(agentWaitingSince("srv-lead"), null);
});
