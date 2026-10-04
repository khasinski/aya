// codex-cli 0.159.3 out of credits, replayed from a real recording. Claude's and Grok's usage-limit screens are
// not recorded: no rule for them until one is.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);

import { test } from "node:test";
import assert from "node:assert/strict";
import { overRecording, readTimes } from "./helpers/own-screen.mjs";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS, PAST_RECORDING_MS } from "./helpers/timings.mjs";

const { paneHold, __testVtPane } = await import("../dist-electron/vt-state.js");
const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { HOLD_USAGE_LIMIT, HOLD_CHOICE } = await import("../dist-electron/pane-holds.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamLiveness } = await import("../dist-electron/team-progress.js");

// The first read that draws the out-of-credits dialog.
const DIALOG_AT = 7_879;
const END = readTimes("codex-credits").at(-1) + PAST_RECORDING_MS;

test("real screen | Codex out of credits: free before the dialog, held as out of credits from it on", async () => {
  const times = [6_000, DIALOG_AT - 3, DIALOG_AT, 9_000, END];
  const holds = await overRecording("codex-credits", "codex", times, (id) => paneHold(id));
  assert.deepEqual(holds, [null, null, HOLD_USAGE_LIMIT, HOLD_USAGE_LIMIT, HOLD_USAGE_LIMIT]);
});

test("real screen | Codex out of credits: a peer message types nothing", async () => {
  const typed = [];
  const outcome = await overRecording("codex-credits", "codex", [END], (id) =>
    deliverTeamMessage(async (_id, data) => (typed.push(data), true), id, "report: the build is green", (pane, pasted) => paneHold(pane, pasted)).then(
      () => "delivered",
      (err) => err.message,
    ),
  );
  assert.match(outcome[0], /out of credits/);
  assert.deepEqual(typed, []);
});

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

test("real screen | Codex out of credits as the lead: no round typed, one log line naming it, the team blocked on it", async () => {
  const [result] = await overRecording("codex-credits", "codex", [END], async (pane) => {
    const { teamHome, project, cleanup } = teamProject("aya-credits-", { teamFile: TEAM });
    try {
      const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
      await store.assign("tester", pane);
      await store.assign("implementer", "pane-i");
      const typed = [];
      const scheduled = [];
      let now = Date.parse("2026-09-30T10:00:00Z");
      const holdReason = async (p) => (p === pane ? paneHold(p) : null);
      const deps = { teamHome, listProjects: async () => [project], deliver: async (p, text) => void typed.push({ p, text }), holdReason, busy: async () => false, headCommit: async () => null };
      const runner = new TeamRunner(deps, (fn) => (scheduled.push(fn), () => {}), () => now);
      await store.setPaused(false);
      await runner.restore();
      // 150 s: past the 2 min a screen must stay up to count as blocked.
      for (let i = 0; i < 10; i++) {
        now += 5 * TEST_TEAM_MINUTE_MS;
        await scheduled.at(-1)();
      }
      const live = await teamLiveness(store, ["tester", "implementer"], holdReason, { cadence: 5, lead: true }, now);
      const log = (await store.log()).map((m) => m.text);
      return { typed, log, live, round: await store.lastRound() };
    } finally {
      cleanup();
    }
  });
  assert.deepEqual(result.typed, [], "nothing typed into the dialog");
  assert.equal(result.round, 0, "a held round does not use up a round number");
  assert.deepEqual(result.log.filter((t) => /skipped/.test(t)), [`round 1 skipped: ${HOLD_USAGE_LIMIT}`]);
  assert.equal(result.live.status, "blocked");
  assert.deepEqual(result.live.blocked.map((b) => [b.role, b.reason]), [["tester", HOLD_USAGE_LIMIT]]);
  assert.equal(result.live.unreached, null, "out of credits is blocked, not unreachable");
  assert.equal(result.live.roundsHeld, null, "no unanswered rounds pile up");
});

const { openVtPane, closeVtPane, writeVtPane } = await import("../dist-electron/vt-state.js");
const MESSAGE = [
  "■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  "  Usage limit reached",
  "  Request a limit increase from your owner to continue using codex. Request increase?",
];
const CHOICE = ["  1. Yes (y)", "› 2. No (default) (n)", "  enter select · esc back"];
const COMPOSER = ["› \x1b[2mAsk Codex to do anything\x1b[22m", "  GPT-6-Luna medium · ~/Projects/aya", "  ← for agents · ? for shortcuts"];

// [label, rows, agent, expected hold]
const ROWS = [
  ["the recorded dialog", [...MESSAGE, ...CHOICE], "codex", HOLD_USAGE_LIMIT],
  ["'Usage limit reached' alone above the choice", [MESSAGE[1], ...CHOICE], "codex", HOLD_USAGE_LIMIT],
  ["'out of credits' alone above the choice", [MESSAGE[0], ...CHOICE], "codex", HOLD_USAGE_LIMIT],
  ["the message left in the transcript, the composer back", [...MESSAGE, ...COMPOSER], "codex", null],
  ["another numbered choice", ["  Pick a model", ...CHOICE], "codex", HOLD_CHOICE],
  ["a later numbered choice, the old message scrolled up out of the tail", [...MESSAGE, ...Array.from({ length: 14 }, (_, i) => `  output ${i}`), "  Pick a model", ...CHOICE], "codex", HOLD_CHOICE],
  ["the dialog on a Claude pane: not recorded there", [...MESSAGE, ...CHOICE], "claude", HOLD_CHOICE],
  ["the dialog on a Grok pane: not recorded there", [...MESSAGE, ...CHOICE], "grok", HOLD_CHOICE],
];
for (const [label, rows, agent, expected] of ROWS) {
  test(`paneHold | out of credits | ${label}`, async () => {
    const id = `credits-${Math.random()}`;
    openVtPane(id, 120, 30, () => {}, agent);
    try {
      writeVtPane(id, rows.join("\r\n"));
      __testVtPane(id).composerSeen = true;
      assert.equal(await paneHold(id), expected);
    } finally {
      closeVtPane(id);
    }
  });
}

const view = await import("../dist-test/team-view.js");
const SINCE = "2026-09-30T10:00:00Z";
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

test("Teams window | the renderer's copy of the hold text is the host's", () => {
  assert.equal(view.HOLD_USAGE_LIMIT, HOLD_USAGE_LIMIT);
});

// [label, blocked reason, team line, role row]
const VIEW = [
  ["out of credits", HOLD_USAGE_LIMIT, `tester ${HOLD_USAGE_LIMIT}`, `${HOLD_USAGE_LIMIT} since ${hhmm(SINCE)}`],
  ["a numbered choice", HOLD_CHOICE, "tester is waiting for you in its CLI", `waiting for you since ${hhmm(SINCE)}`],
];
for (const [label, reason, line, row] of VIEW) {
  test(`Teams window | a role blocked on ${label}`, () => {
    const blocked = [{ role: "tester", reason, since: SINCE }];
    const live = { status: "blocked", stalledSince: null, stalledOn: null, repo: null, blocked, unreached: null, silence: null, roundsHeld: null };
    assert.equal(view.livenessLine(live).text, line);
    const team = { assignments: { tester: "pane-t" }, paneHolds: { tester: reason }, liveness: live };
    assert.equal(view.roleStatus(team, "tester", [{ id: "pane-t" }]).text, row);
  });
}
