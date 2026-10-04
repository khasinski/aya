// Claude Code 2.1.289's one-time offer to block reads outside the working directories (auto mode, an account's first
// outside read), replayed from real recordings at 120 and 64 columns: its answer is written to the account's settings,
// so one click in a team pane froze every session on the account (2026-10-03). Codex 0.160.0 has no such offer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overRecording, readTimes } from "./helpers/own-screen.mjs";
import { PAST_RECORDING_MS } from "./helpers/timings.mjs";

const { paneHold, openVtPane, closeVtPane, writeVtPane, __testVtPane } = await import("../dist-electron/vt-state.js");
const H = await import("../dist-electron/pane-holds.js");
const { startControlServerOn } = await import("../dist-electron/control.js");
const { roundDigest } = await import("../dist-electron/team-digest.js");
const { WALL_MINUTE_MS, clock } = await import("../dist-electron/team-times.js");
const view = await import("../dist-test/team-view.js");
const { applyPtyEvent } = await import("../dist-test/pty-event-reducer.js");
const { attentionFor } = await import("../dist-test/attention.js");

const OFFER = H.HOLD_ACCOUNT_SETTING;

test("the hold names the offer, the setting and that it is account-wide", () => {
  assert.equal(OFFER, "Claude Code offers an account-wide setting: block reads outside the working directories; your choice applies to every session on this account");
  assert.equal(view.HOLD_ACCOUNT_SETTING, OFFER, "the Teams window's copy is the host's");
});

// The first read that draws the offer in each recording.
const RECORDINGS = [
  ["120 columns", "claude-offer", 179_504],
  ["64 columns, its options wrapped", "claude-offer-narrow", 21_315],
];
for (const [label, name, at] of RECORDINGS) {
  test(`real screen | Claude Code's read offer at ${label}: free before it, held as the offer from it on`, async () => {
    const end = readTimes(name).at(-1) + PAST_RECORDING_MS;
    const holds = await overRecording(name, "claude", [at - 1, at, end], (id) => paneHold(id));
    assert.deepEqual(holds, [null, OFFER, OFFER]);
  });
  test(`real screen | Claude Code's read offer at ${label} on a Codex pane is no offer: Codex draws none`, async () => {
    const [hold] = await overRecording(name, "codex", [readTimes(name).at(-1)], (id) => paneHold(id));
    assert.ok(H.isDialogHold(hold) && hold !== OFFER, hold);
  });
}

// Rows of the recorded 120-column dialog, and the screens it is told apart from.
const RULE = "─".repeat(60);
const OFFER_ROWS = [
  " Read outside the working directories",
  " Allow this read outside the working directories?",
  " ❯ 1. Yes, and keep allowing any reads outside the working directories",
  "   2. No, and block reads outside the working directories from now on",
  "   3. No, and ask again next time",
  "   4. Yes, but ask again next time",
  "",
  " Esc to cancel · Tab to amend",
];
const OFFER_ON_2 = OFFER_ROWS.map((r) => r.replace("❯ 1.", "  1.").replace("  2. No, and block", "❯ 2. No, and block"));
const CLAUDE_APPROVAL = [" Read file", "  Read(/tmp/x)", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, allow reading from tmp/ during this session", "   3. No", "", " Esc to cancel · Tab to amend"];
const CLAUDE_CHOICE = [" Pick one", "   1. Red", " ❯ 2. Blue"];
const CLAUDE_FREE = [RULE, "❯ ", RULE, "  ? for shortcuts"];
// Its "don't ask again" is for one command prefix: an approval, not an account's setting.
const CODEX_APPROVAL = [
  "  Would you like to run the following command?",
  "  $ npm test",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `npm test` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "  Press enter to confirm or esc to cancel",
];
const CODEX_CHOICE = ["  Pick a model", "  1. Yes (y)", "› 2. No (default) (n)", "  enter select · esc back"];
const CODEX_FREE = ["› \x1b[2mAsk Codex to do anything\x1b[22m", "  GPT-6-Luna medium · ~/Projects/aya", "  ← for agents · ? for shortcuts"];

const SINCE_MIN = 10;
const NOW = Date.parse("2026-10-03T12:30:00.000Z");
const SINCE = new Date(NOW - SINCE_MIN * WALL_MINUTE_MS).toISOString();

// What Aya does per kind: [hold, the pane's waiting line, an agent's `aya pane send` typed, round digest, team line, role row].
const ASK = "Approval or input needed";
const KIND = {
  offer: [OFFER, OFFER, false, `stuck ${SINCE_MIN} min: ${OFFER} (only the user)`, `tester is waiting for you: ${OFFER}`, `waiting for you since ${clock(SINCE)}: ${OFFER}`],
  approval: [H.HOLD_APPROVAL, ASK, true, `stuck ${SINCE_MIN} min: approval prompt (only the user)`, "tester is waiting for you in its CLI", `waiting for you since ${clock(SINCE)}`],
  choice: [H.HOLD_CHOICE, ASK, true, `stuck ${SINCE_MIN} min: numbered choice (only the user)`, "tester is waiting for you in its CLI", `waiting for you since ${clock(SINCE)}`],
  free: [null, null, true, null, null, null],
};

// [screen, CLI, rows, kind]
const ROWS = [
  ["offer", "claude", OFFER_ROWS, "offer"],
  ["offer, its cursor moved to the block option", "claude", OFFER_ON_2, "offer"],
  ["ordinary approval", "claude", CLAUDE_APPROVAL, "approval"],
  ["numbered choice", "claude", CLAUDE_CHOICE, "choice"],
  ["free", "claude", CLAUDE_FREE, "free"],
  ["offer: none in Codex, Claude's wording there stays an approval", "codex", OFFER_ROWS, "approval"],
  ["ordinary approval with its per-command don't-ask-again", "codex", CODEX_APPROVAL, "approval"],
  ["numbered choice", "codex", CODEX_CHOICE, "choice"],
  ["free", "codex", CODEX_FREE, "free"],
];

/** The pane's hold and the last vt-status (waiting, dialog) its scan sent, as the pty host's mirror gives them. */
async function screenOf(agent, rows) {
  const id = `offer-${Math.random()}`;
  const sent = [];
  openVtPane(id, 120, 30, (waiting, dialog) => sent.push({ waiting, dialog }), agent);
  try {
    writeVtPane(id, rows.join("\r\n"));
    __testVtPane(id).composerSeen = true;
    const hold = await paneHold(id);
    await new Promise((done) => setTimeout(done, 400));
    return { id, hold, last: sent.at(-1) ?? { waiting: false, dialog: undefined }, close: () => closeVtPane(id) };
  } catch (err) {
    closeVtPane(id);
    throw err;
  }
}

/** `aya pane send tester "2"` from another pane, through the control server with the real hold read. */
async function paneSendTyped(id) {
  const dir = mkdtempSync(join(tmpdir(), "aya-offer-send-"));
  const socket = join(dir, "aya.sock");
  const writes = [];
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    listProjects: async () => [{ slug: "aya", tabs: [{ id, name: "tester" }] }],
    readPane: async () => "",
    writePane: async (terminalId, data) => void writes.push(data),
    paneHold: (terminalId) => paneHold(terminalId),
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const c = net.createConnection(socket);
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (chunk) => (buf += chunk));
      c.on("close", () => resolve(JSON.parse(buf.split("\n")[0])));
      c.on("error", reject);
      c.write(`${JSON.stringify({ type: "pane-send", target: "tester", text: "2", submit: false })}\n`);
    });
    return { reply, writes };
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [screen, cli, rows, kind] of ROWS) {
  const [hold, line, typed, digest, teamLine, roleRow] = KIND[kind];
  test(`${cli} | ${screen} | hold ${kind}, who can clear it, and the text each place shows`, async () => {
    const pane = await screenOf(cli, rows);
    try {
      assert.equal(pane.hold, hold, "the hold");
      assert.equal(H.isDialogHold(pane.hold), hold !== null, "a team message waits for the user");
      assert.equal(H.isUserOnlyHold(pane.hold), kind === "offer", "only the user may answer it");

      // The pane's waiting line (sidebar attention row), from the vt-status the scan sent.
      const terminal = { id: pane.id, projectSlug: "aya", presetId: cli, name: "tester", cwd: "/", status: "running", bell: false, exitCode: null };
      const state = applyPtyEvent({ [pane.id]: terminal }, { type: "vt-status", ptyId: pane.id, ...pane.last });
      assert.equal(attentionFor({ slug: "aya" }, state[pane.id])?.detail ?? null, line, "the pane's waiting line");

      const { reply, writes } = await paneSendTyped(pane.id);
      assert.equal(reply.ok, typed, `aya pane send: ${JSON.stringify(reply)}`);
      assert.deepEqual(writes, typed ? ["2"] : [], "what an agent typed into it");
      if (!typed) assert.equal(reply.error, `pane "tester": ${OFFER}. Only the user answers it, in that pane; nothing was typed`);

      const progress = hold ? { blocked: { tester: { reason: hold, since: SINCE } } } : null;
      const d = roundDigest({ roles: ["lead", "tester"], lead: "lead", log: [], progress, refused: [], turns: null, busy: ["tester"], nowMs: NOW });
      const needs = d.sections.find((s) => s.title === "Needs action");
      assert.deepEqual(needs?.items ?? null, digest === null ? null : [`tester  ${digest}`], "the lead's round");

      const blocked = hold ? [{ role: "tester", reason: hold, since: SINCE }] : [];
      const live = { status: hold ? "blocked" : "progressing", stalledSince: null, stalledOn: null, repo: null, blocked, unreached: null, silence: null, roundsHeld: null };
      const team = { assignments: { tester: pane.id }, paneHolds: { tester: hold }, liveness: live };
      assert.equal(hold ? view.livenessLine(live).text : null, teamLine, "the Teams window's team line");
      assert.equal(hold ? view.roleStatus(team, "tester", [{ id: pane.id }]).text : null, roleRow, "the Teams window's role row");
    } finally {
      pane.close();
    }
  });
}

test("the waiting line goes back to the generic ask once the offer is answered and an ordinary approval is up", () => {
  const t = { id: "p", projectSlug: "aya", presetId: "claude", name: "tester", cwd: "/", status: "running", bell: false, exitCode: null };
  let s = applyPtyEvent({ p: t }, { type: "vt-status", ptyId: "p", waiting: true, dialog: OFFER });
  assert.equal(attentionFor({ slug: "aya" }, s.p).detail, OFFER);
  s = applyPtyEvent(s, { type: "vt-status", ptyId: "p", waiting: true });
  assert.equal(attentionFor({ slug: "aya" }, s.p).detail, ASK);
  s = applyPtyEvent(applyPtyEvent(s, { type: "vt-status", ptyId: "p", waiting: true, dialog: OFFER }), { type: "vt-status", ptyId: "p", waiting: false });
  assert.equal(s.p.screenDialog, undefined);
  assert.equal(attentionFor({ slug: "aya" }, s.p)?.level === "waiting", false);
});

test("the pane's scan names the offer when it replaces an ordinary approval, and drops the name once it is gone", async () => {
  const id = `offer-swap-${Math.random()}`;
  const sent = [];
  openVtPane(id, 120, 30, (waiting, dialog) => sent.push([waiting, dialog]), "claude");
  const show = async (rows) => {
    writeVtPane(id, `\x1b[2J\x1b[H${rows.join("\r\n")}`);
    await new Promise((done) => setTimeout(done, 400));
  };
  try {
    __testVtPane(id).composerSeen = true;
    await show(CLAUDE_APPROVAL);
    await show(OFFER_ROWS);
    await show(CLAUDE_APPROVAL);
    await show(CLAUDE_FREE);
    assert.deepEqual(sent, [[true, undefined], [true, OFFER], [true, undefined], [false, undefined]]);
  } finally {
    closeVtPane(id);
  }
});
