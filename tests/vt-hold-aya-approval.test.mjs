// A pane asking the user to approve an `aya` command cannot report, so the Teams window must name that hold rather than
// a plain approval prompt; the screens are the Bash approvals Claude Code and Codex 0.159 draw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asksToRunAya, TAIL_REGION_LINES } from "../dist-electron/agent-screen-rules.js";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

// paneHold waits for xterm's write callback before reading; no parser sleep is needed.

const fixture = (name) => readFileSync(join(process.cwd(), "tests", "fixtures", "approval-screens", name), "utf8").trimEnd().split("\n");

async function hold(screen, agent, cols = 100) {
  openVtPane("a", cols, 30, () => {}, agent, false);
  try {
    writeVtPane("a", typeof screen === "string" ? screen : screen.join("\r\n"));
    return await paneHold("a");
  } finally {
    closeVtPane("a");
  }
}

const AYA = "waiting for you to approve an aya command";
const GENERIC = "shows an approval prompt";

// [agent, fixture, expected hold]. Synthetic - to record: a non-aya approval, and the idle composer after an aya one.
const TABLE = [
  ["claude", "synthetic-claude-git-status.txt", GENERIC],
  ["codex", "synthetic-codex-git-status.txt", GENERIC],
  ["claude", "synthetic-claude-idle-after-aya.txt", null],
  ["codex", "synthetic-codex-idle-after-aya.txt", null],
];

for (const [agent, name, expected] of TABLE) {
  test(`${agent}: ${name} -> ${expected ?? "no hold"}`, async () => {
    assert.equal(await hold(fixture(name), agent), expected);
  });
}

// Byte streams a real Claude Code 2.1.285 and Codex 0.159.2 wrote into a 30-row pty
// (fake model API, tool call `aya team send ...`, --permission-mode default / -a on-request).
const recorded = (name) => readFileSync(join(process.cwd(), "tests", "fixtures", "approval-screens", name), "utf8");
const RECORDED = [["claude", 40], ["claude", 60], ["claude", 100], ["codex", 40], ["codex", 50], ["codex", 100]];

for (const [agent, cols] of RECORDED) {
  test(`recorded ${agent} approval prompt at ${cols} columns -> aya wording`, async () => {
    assert.equal(await hold(recorded(`recorded-${agent}-${cols}.txt`), agent, cols), AYA);
  });
}

test("an agent without screen rules of its own gets the same wording", async () => {
  assert.equal(await hold(recorded("recorded-claude-100.txt"), "opencode"), AYA);
});

test("every aya subcommand in an approval prompt is an aya command", () => {
  for (const sub of ["open", "project", "focus", "notify", "remote", "status", "pane", "team", "presets", "capabilities"]) {
    assert.equal(asksToRunAya([`  $ aya ${sub} x`]), true, sub);
    assert.equal(asksToRunAya([`  $ FOO=1 aya  ${sub}`]), true, `${sub} after an assignment`);
  }
});

test("aya inside a path, a longer word or another command is not an aya command", () => {
  for (const row of ["  $ cd /Users/dev/aya status", "  $ ls my-aya team", "  $ ls maya team", "  $ ./aya team send x", "  $ aya", "  $ ayatana team", "  $ aya teamwork", "  $ ayateam send x"]) {
    assert.equal(asksToRunAya([row]), false, row);
  }
});

test("an aya command scrolled out of the tail region does not count", async () => {
  const old = ["● Bash(aya team send reviewer \"Round 1\")", ...Array.from({ length: TAIL_REGION_LINES }, (_, i) => `  output line ${i}`)];
  assert.equal(await hold([...old, ...fixture("synthetic-claude-git-status.txt")], "claude"), GENERIC);
});
