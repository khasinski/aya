// A busy agent (working, composer empty) gets no rounds queued: on finish it sees one round, not N.

// One cadence "minute" lasts 3 s here: a 5 min cadence is 15 s and the 60 min stall limit is 3 min.
process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { openVtPane, closeVtPane, writeVtPane, paneHold, paneBusy } = await import("../dist-electron/vt-state.js");
const { teamLiveness } = await import("../dist-electron/team-progress.js");

const DIM = (s) => `\x1b[2m${s}\x1b[22m`;
const RULE = "─".repeat(60);
const fixture = (name) => readFileSync(new URL(`./fixtures/busy-${name}.screen.txt`, import.meta.url), "utf8").trimEnd().split("\n");
const APPROVAL = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
const BOX = (inner) => ["╭" + RULE + "╮", `│ ❯ ${inner.padEnd(56)} │`, "╰" + RULE + "╯"];

const SCREENS = {
  claude: { free: [RULE, "❯ ", RULE, "  ? for shortcuts"], busy: fixture("claude"), approval: APPROVAL },
  codex: { free: ["› " + DIM("Ask Codex to do anything"), "  GPT-6-Luna medium", "  ← for agents · ? for shortcuts"], busy: fixture("codex"), approval: APPROVAL },
  opencode: {
    free: ["┃  Ask anything...", "┃  Build · Big Pickle OpenCode Zen", "╹▀▀▀▀▀▀", "  /Users/x/p   ctrl+p commands    • OpenCode 1.18.30"],
    busy: fixture("opencode"),
    approval: APPROVAL,
  },
  grok: { free: BOX(""), busy: fixture("grok"), approval: APPROVAL },
};

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report

## Cadence
tester every 5 min
`;

async function world(cli, screen) {
  const { teamHome, project, cleanup } = teamProject("aya-busy-", { teamFile: TEAM });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { typed: [], scheduled: [], now: Date.parse("2026-09-30T10:00:00Z"), store, cleanup };
  const show = async (rows) => {
    closeVtPane("pane-t");
    openVtPane("pane-t", 100, 30, () => {}, cli);
    writeVtPane("pane-t", rows.join("\r\n"));
    await new Promise((r) => setTimeout(r, 30));
  };
  w.show = async (name) => show(SCREENS[cli][name]);
  const vt = (fn, otherwise) => async (pane) => (pane === "pane-t" ? fn("pane-t") : otherwise);
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text }),
    holdReason: vt(paneHold, null),
    busy: vt(paneBusy, false),
    headCommit: async () => null,
  };
  w.runner = new TeamRunner(w.deps, (fn) => (w.scheduled.push(fn), () => {}), () => w.now);
  w.tick = async () => {
    w.now += 5 * TEST_TEAM_MINUTE_MS;
    await w.scheduled.at(-1)();
  };
  w.rounds = () => w.typed.filter((t) => t.pane === "pane-t" && /Round \d+:/.test(t.text));
  w.close = () => (closeVtPane("pane-t"), cleanup());
  await w.show(screen);
  await w.store.setPaused(false);
  await w.runner.restore();
  return w;
}

for (const cli of Object.keys(SCREENS)) {
  for (const screen of ["free", "busy", "approval"]) {
    const free = screen === "free";
    test(`${cli} ${screen}: a round is ${free ? "typed" : "held"}`, async () => {
      const w = await world(cli, screen);
      try {
        await w.tick();
        assert.equal(w.rounds().length, free ? 1 : 0);
        const last = (await w.store.log()).at(-1);
        if (screen === "busy") assert.equal(last.text, "round 1 skipped: is busy working");
        if (screen === "approval") assert.equal(last.text, "round 1 skipped: shows an approval prompt");
        assert.equal(await w.store.lastRound(), free ? 1 : 0, "a held round does not use up a round number");
      } finally {
        w.close();
      }
    });

    test(`${cli} ${screen}: a peer report is ${screen === "approval" ? "held, then typed once when the pane frees" : "typed once"}`, async () => {
      const w = await world(cli, screen);
      try {
        await w.store.append({ from: "implementer", to: "tester", commit: null, text: "report: the build is green", delivered: false });
        const held = screen === "approval";
        assert.equal(await w.runner.redeliverWaiting(), held ? 0 : 1);
        if (held) {
          await w.show("free");
          assert.equal(await w.runner.redeliverWaiting(), 1);
        }
        assert.equal(await w.runner.redeliverWaiting(), 0, "exactly once");
        assert.equal(w.typed.filter((t) => /report: the build is green/.test(t.text)).length, 1);
      } finally {
        w.close();
      }
    });
  }
}

test("5 busy rounds, then the agent finishes: it sees exactly one round, the latest", async () => {
  const w = await world("claude", "busy");
  try {
    for (let i = 0; i < 5; i++) await w.tick();
    assert.equal(w.rounds().length, 0);
    await w.show("free");
    await w.tick();
    assert.equal(w.rounds().length, 1);
    assert.match(w.rounds()[0].text, /Round 1:/);
    await w.tick();
    assert.equal(w.rounds().length, 2, "back to one round per tick");
  } finally {
    w.close();
  }
});

test("a busy-skipped tick, a re-arm, then both timers firing on a free agent: one round, not two", async () => {
  const w = await world("claude", "busy");
  try {
    await w.tick();
    assert.equal(w.rounds().length, 0);
    const oldTimer = w.scheduled.at(-1);
    await w.runner.resume("game", "ux-review");
    const newTimer = w.scheduled.at(-1);
    assert.notEqual(newTimer, oldTimer);
    await w.show("free");
    w.now += 5 * TEST_TEAM_MINUTE_MS;
    await oldTimer();
    assert.equal(w.rounds().length, 0, "the superseded arm types nothing");
    await Promise.all([oldTimer(), newTimer()]);
    assert.equal(w.rounds().length, 1, "one round for the two timers");
    assert.match(w.rounds()[0].text, /Round 1:/);
  } finally {
    w.close();
  }
});

test("a role busy on one long task is working, not stalled", async () => {
  const w = await world("codex", "free");
  try {
    await w.tick();
    await w.show("busy");
    // Only the repo's clock stalls a team (180 s here, 12 ticks).
    for (let i = 0; i < 8; i++) await w.tick();
    const live = await teamLiveness(w.store, ["tester", "implementer"], w.deps.holdReason, { cadence: 5, lead: true }, w.now);
    assert.equal(live.status, "progressing");
    assert.equal(w.rounds().length, 1);
    await w.show("free");
    for (let i = 0; i < 4; i++) await w.tick();
    assert.equal((await teamLiveness(w.store, ["tester", "implementer"], w.deps.holdReason, { cadence: 5, lead: true }, w.now)).status, "stalled");
  } finally {
    w.close();
  }
});

test("measured: the hold check reads a busy composer as free (busy is a separate signal)", async () => {
  for (const cli of ["claude", "codex", "opencode"]) {
    const w = await world(cli, "busy");
    try {
      assert.equal(await paneHold("pane-t"), null, cli);
      assert.equal(await paneBusy("pane-t"), true, cli);
    } finally {
      w.close();
    }
  }
});

test("paneBusy reads the screen after the writes still queued in xterm (like paneHold)", async () => {
  const w = await world("claude", "free");
  try {
    closeVtPane("pane-t");
    openVtPane("pane-t", 100, 30, () => {}, "claude");
    writeVtPane("pane-t", SCREENS.claude.busy.join("\r\n"));
    assert.equal(await paneBusy("pane-t"), true, "no settle between the write and the check");
  } finally {
    w.close();
  }
});

test("an idle pane that only quotes a busy footer is not busy", async () => {
  const quoting = {
    claude: ["● The footer reads: esc to interrupt", RULE, "❯ ", RULE, "  ? for shortcuts"],
    codex: ["• The status line Working (3s • esc to interrupt) is what Codex draws", "› " + DIM("Ask Codex to do anything"), "  GPT-6-Luna medium"],
    opencode: ["  an interrupt handler was added", "┃  Ask anything...", "  /Users/x/p   ctrl+p commands"],
  };
  for (const [cli, rows] of Object.entries(quoting)) {
    SCREENS[cli].quoting = rows;
    const w = await world(cli, "quoting");
    try {
      assert.equal(await paneBusy("pane-t"), false, cli);
    } finally {
      w.close();
    }
  }
});

// Claude's approval dialog replaces its busy footer; Codex and OpenCode keep theirs above the prompt.
for (const cli of ["claude", "codex", "opencode"]) {
  test(`${cli}: busy and an approval prompt at once: the round is held for the approval, not for busy`, async () => {
    SCREENS[cli].both = [...SCREENS[cli].busy, ...APPROVAL];
    const w = await world(cli, "busy");
    try {
      assert.equal(await paneBusy("pane-t"), true, "the busy screen alone is busy");
      await w.show("both");
      await w.tick();
      assert.equal(w.rounds().length, 0);
      // The busy fixtures quote an `aya team whoami` message, so the prompt below can read as an aya approval.
      assert.match((await w.store.log()).at(-1).text, /^round 1 skipped: (shows an approval prompt|waiting for you to approve an aya command)$/);
    } finally {
      w.close();
    }
  });
}
