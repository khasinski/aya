// Real CLI screens replayed with their timing: a dialog must hold a team message, as its Enter would answer the
// dialog. Codex 0.159.3 draws its composer while still "loading", ~0.35 s before its trust or update dialog.

import { test } from "node:test";
import assert from "node:assert/strict";
import { overRecording, readTimes } from "./helpers/own-screen.mjs";
import { PAST_RECORDING_MS } from "./helpers/timings.mjs";

const { paneHold, openVtPane, closeVtPane, writeVtPane, screenRows, __testVtPane } = await import("../dist-electron/vt-state.js");
const { evaluateScreen } = await import("../dist-electron/agent-screen-rules.js");
const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { HOLD_STARTING, HOLD_CHOICE, HOLD_APPROVAL, HOLD_DRAFT } = await import("../dist-electron/pane-holds.js");

const DIALOG = new Set([HOLD_CHOICE, HOLD_APPROVAL]);

// [label, recording, agent, time (ms, or "end"), expected: null (free), HOLD_STARTING, or "dialog"]
const ROWS = [
  ["R-A1 OpenCode, composer before the update box", "opencode-idle", "opencode", 4_000, null],
  ["R-A1 OpenCode, update box over the composer", "opencode-idle", "opencode", "end", "dialog"],
  ["R-A2 Codex, composer drawn while loading (fresh dir)", "codex-trust", "codex", 418, HOLD_STARTING],
  ["R-A2 Codex, composer drawn while loading, a moment later", "codex-trust", "codex", 700, HOLD_STARTING],
  ["R-A2 Codex, trust dialog", "codex-trust", "codex", "end", "dialog"],
  ["R-A2 Codex, composer drawn while loading (update pending)", "codex-idle", "codex", 315, HOLD_STARTING],
  ["R-A2 Codex, update dialog", "codex-idle", "codex", "end", "dialog"],
  ["R-A3 Antigravity, trust dialog", "agy-trust", "antigravity", "end", "dialog"],
  ["R-A3 Antigravity, / command palette", "agy-palette", "antigravity", "end", "dialog"],
  ["R-A3 Antigravity, idle composer", "agy-idle", "antigravity", "end", null],
  ["R-A4 hermes, Set up a provider now? [Y/n]:", "hermes-idle", undefined, "end", "dialog"],
  ["Claude, trust dialog", "claude-trust", "claude", "end", "dialog"],
  ["Claude, idle composer", "claude-idle", "claude", "end", null],
  ["Grok, idle composer", "grok-idle", "grok", "end", null],
];

const at = async (recording, agent, time, visit) => {
  const t = time === "end" ? readTimes(recording).at(-1) + PAST_RECORDING_MS : time;
  return (await overRecording(recording, agent, [t], visit))[0];
};

const expectHold = (hold, expected) => {
  if (expected === "dialog") assert.ok(DIALOG.has(hold), `a dialog, got ${hold}`);
  else assert.equal(hold, expected);
};

for (const [label, recording, agent, time, expected] of ROWS) {
  test(`real screen | ${label} -> ${expected ?? "free"}`, async () => {
    expectHold(await at(recording, agent, time, (id) => paneHold(id)), expected);
  });
  if (expected === null) continue;
  test(`real screen | ${label} | a team message types nothing`, async () => {
    const typed = [];
    const outcome = await at(recording, agent, time, (id) =>
      deliverTeamMessage(async (_id, data) => (typed.push(data), true), id, "Round 3: what is blocked?", (paneId, pasted) => paneHold(paneId, pasted)).then(
        () => "delivered",
        (err) => err.message,
      ),
    );
    assert.notEqual(outcome, "delivered");
    assert.deepEqual(typed, []);
  });
}

test("real screen | R-A3 Antigravity, a draft on the idle composer holds as a draft", async () => {
  const hold = await at("agy-idle", "antigravity", "end", async (id) => {
    // Row 8 of the idle screen is the empty "> " composer.
    writeVtPane(id, "\x1b[9;3Hhalf typed");
    return paneHold(id);
  });
  assert.equal(hold, HOLD_DRAFT);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("real screen | R-A1 OpenCode's update box holds even when its composer ends the screen (a short pane: no tip, no footer)", async () => {
  const rows = await at("opencode-idle", "opencode", "end", async (id) => (await paneHold(id), screenRows(__testVtPane(id).terminal)));
  const edge = rows.findIndex((row) => /^\s*╹▀/.test(row));
  assert.ok(edge > 0, "the composer's edge is on screen");
  assert.equal(evaluateScreen(rows.slice(0, edge + 2), "opencode"), "waiting");
});

test("real screen | R-A2 Codex's composer while loading stays starting after the pane's own screen scan has run", async () => {
  const hold = await at("codex-trust", "codex", 418, async (id) => (await sleep(400), paneHold(id)));
  assert.equal(hold, HOLD_STARTING);
});

test("real screen | Grok's idle composer is free as soon as it is drawn: its logo is no reason to wait", async () => {
  assert.equal(await at("grok-idle", "grok", 300, (id) => paneHold(id)), null);
});

test("real screen | R-A3 Antigravity that has not drawn its composer yet is starting up, not busy", async () => {
  const realNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  openVtPane("agy-start", 120, 30, () => {}, "antigravity");
  try {
    writeVtPane("agy-start", "\x1b[2J\x1b[H  Antigravity CLI 1.2.14\r\n  Loading workspace...\r\n");
    now += 5_000;
    assert.equal(await paneHold("agy-start"), HOLD_STARTING);
  } finally {
    closeVtPane("agy-start");
    Date.now = realNow;
  }
});

test("real screen | R-A3 a team message to Antigravity's idle composer is pasted, then entered", async () => {
  const typed = await at("agy-idle", "antigravity", "end", async (id) => {
    const out = [];
    const write = async (_id, data) => {
      out.push(data);
      if (data.startsWith("\x1b[200~")) writeVtPane(id, `\x1b[9;1H> ${data.slice(6, -6)}`);
      return true;
    };
    await deliverTeamMessage(write, id, "Round 3: what is blocked?", (paneId, pasted) => paneHold(paneId, pasted));
    return out;
  });
  assert.deepEqual(typed, ["\x1b[200~Round 3: what is blocked?\x1b[201~", "\r"]);
});

// The yes/no prompt is the screen's last line, the cursor's; the same words above a prompt row are not.
const YN = [
  ["a line prompt with a colon, any CLI", undefined, ["Set up a provider now? [Y/n]: "], "waiting"],
  ["(y/N) with a colon", undefined, ["Overwrite the file? (y/N): "], "waiting"],
  ["the prompt quoted above a shell-like prompt row", undefined, ["It asked: Set up a provider now? [Y/n]:", "> "], "clear"],
  ["the prompt quoted in Claude's transcript above its composer", "claude", ["⏺ It asked: Set up a provider now? [Y/n]:", "─".repeat(40), "❯ ", "─".repeat(40)], "clear"],
];
for (const [label, agent, rows, verdict] of YN) {
  test(`yes/no line prompt | ${label}`, () => assert.equal(evaluateScreen(rows, agent), verdict));
}
