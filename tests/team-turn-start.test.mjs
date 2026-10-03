// An Enter that lands in a dialog, or that the CLI never takes, is not a message the agent heard.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __testVtPane, closeVtPane, openVtPane, paneHold, screenRows, writeVtPane } from "../dist-electron/vt-state.js";
import { fixture } from "./helpers/vt-screens.mjs";

const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { deliverAndLog } = await import("../dist-electron/team-control.js");
const { observe } = await import("../dist-electron/team-progress.js");
const { TeamStore } = await import("../dist-electron/team-store.js");
const { messageDeliveryText } = await import("../dist-test/team-view.js");

const CLEAR = "\x1b[2J\x1b[H";
const draw = (rows) => CLEAR + rows.join("\r\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
const WINDOW_MS = 2_000;
const REACTS_MS = 300;
const NOT_SEEN = "typed, not seen to start a turn";
const DIALOG = /^typed, but a dialog came up after its Enter: (shows an approval prompt|shows a numbered choice)$/;

const replaceRow = (rows, test, row) => rows.map((r) => (test.test(r) ? row : r));
const CLAUDE_IDLE = fixture("claude-idle-composer.raw").join("\n");
const CODEX_BUSY = fixture("busy-codex.screen.txt");
const CODEX_IDLE = CODEX_BUSY.filter((r) => !/Working/.test(r));
const GROK_IDLE = fixture("grok-screens/idle-empty-composer.txt");
const ASK = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];

const CLIS = {
  claude: {
    idle: CLAUDE_IDLE,
    draft: (text) => CLAUDE_IDLE.replace("\x1b[7m \r", `${text}\x1b[7m \x1b[27m\r`),
    started: draw(fixture("busy-claude.screen.txt")),
    dialog: draw(ASK),
  },
  codex: {
    idle: draw(CODEX_IDLE),
    draft: (text) => draw(replaceRow(CODEX_IDLE, /Ask Codex to do anything/, `› ${text}`)),
    started: draw(CODEX_BUSY),
    dialog: draw(["Would you like to run the following command?", "  $ npm install -g @openai/codex", "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)"]),
  },
  grok: {
    idle: draw(GROK_IDLE),
    draft: (text) => draw(replaceRow(GROK_IDLE, /│ ❯/, `  │ ❯ ${text}`)),
    // Grok has no busy rule of ours: its composer emptied by the submit is the sign.
    started: draw(["  ⏺ on it", ...GROK_IDLE]),
    dialog: draw(ASK),
  },
  opencode: {
    idle: draw(fixture("opencode-idle.screen.txt")),
    draft: () => draw(fixture("opencode-pasted.screen.txt")),
    started: draw(fixture("busy-opencode.screen.txt")),
    dialog: draw(fixture("opencode-permission-80.screen.txt")),
  },
  // An agent with no composer rule: only output after Enter shows it took the text.
  other: {
    agent: "kilo",
    idle: draw(["kilo 1.0", "> "]),
    draft: () => draw(["kilo 1.0", "> "]),
    started: "\r\nthinking about it\r\n",
    dialog: draw(ASK),
  },
};

/** A fake clock for the window after Enter: sleep advances it and fires what fell due. */
function fakeClock() {
  let now = 0;
  const due = [];
  return {
    at: (ms, fn) => due.push({ t: now + ms, fn }),
    async sleep(ms) {
      now += ms;
      for (const d of due.filter((x) => x.t <= now)) {
        due.splice(due.indexOf(d), 1);
        d.fn();
      }
      // The next probe.hold read drains xterm via its write callback.
    },
  };
}

let seq = 0;
/** A stand-in pane for `cli`: the paste shows in its composer; `afterEnter` is drawn `delayMs` after Enter
 *  ("redraws": the composer with the text again, every delayMs, as an animated CLI that never took it). */
function standIn(name, afterEnter, delayMs = REACTS_MS, { dialogOnPaste = false } = {}) {
  const cli = CLIS[name];
  const id = `turn-${name}-${(seq += 1)}`;
  const clock = fakeClock();
  let output = 0;
  const show = (data) => {
    output += 1;
    writeVtPane(id, data);
  };
  openVtPane(id, 130, 40, () => {}, cli.agent ?? name, false);
  show(cli.idle);
  const pane = __testVtPane(id);
  pane.openedAt = 0; // a CLI with no composer rule is up once its start-up time has passed
  const enters = [];
  let redraw;
  const write = async (_id, data) => {
    const pasted = PASTE.exec(data);
    if (pasted) {
      show(cli.draft(pasted[1]));
      if (dialogOnPaste) show(cli.dialog);
      redraw = () => show(cli.draft(pasted[1]));
    } else if (data === "\r") {
      enters.push(data);
      if (afterEnter === "redraws") for (let t = delayMs; t <= 2 * WINDOW_MS; t += delayMs) clock.at(t, redraw);
      else if (afterEnter !== "nothing") clock.at(delayMs, () => show(afterEnter === "started" ? cli.started : cli.dialog));
    }
  };
  const probe = { hold: paneHold, outputMark: () => output, outputPaused: () => true, windowMs: WINDOW_MS, sleep: clock.sleep };
  return { id, write, probe, enters, close: () => closeVtPane(id) };
}

async function withTeam(run) {
  const root = mkdtempSync(join(tmpdir(), "aya-turn-start-"));
  try {
    return await run(new TeamStore(join(root, "team")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One report through `pane` in a fresh team, handed to `check`; the pane is closed after. */
async function reportThrough(pane, check) {
  try {
    await withTeam(async (store, root) => check(await report(pane, store, root), store, root));
  } finally {
    pane.close();
  }
}

/** The tester's report typed to the implementer's pane, logged; then one look of the team's clock. */
async function report(pane, store, root, text = "round 5 ready") {
  await store.assign("implementer", pane.id);
  const deps = {
    deliver: (tid, line, cancelled) => deliverTeamMessage(pane.write, tid, line, (id, p) => paneHold(id, p), cancelled, pane.probe),
    holdReason: (id) => paneHold(id),
    headCommit: async () => "abc1234",
  };
  const sent = await deliverAndLog(deps, { directory: root }, store, { team: "ux-review", from: "tester", to: "implementer", text });
  const progress = await observe(store, "abc1234", {}, new Date().toISOString());
  return { ...sent, heard: progress.messages ?? 0, deps };
}

// Each pane, output counter, fake clock and TeamStore belongs to one case.
// Keep the real submit gap and the same observation window, in parallel.
describe("turn detection on independent panes", { concurrency: 8 }, () => {
  const AFTER_ENTER = [
    ["a turn starts", "started", (r) => {
      assert.equal(r.failure, null);
      assert.equal(r.entry.typedOnly, undefined);
      assert.equal(r.heard, 1, "a message that started a turn is talk");
      assert.equal(messageDeliveryText(r.entry), "written");
    }],
    ["nothing happens", "nothing", (r) => {
      assert.equal(r.entry.delivered, true, "it is in the pane: never typed again");
      assert.equal(r.entry.typedOnly, true);
      assert.equal(r.entry.held, NOT_SEEN);
      assert.equal(r.heard, 0, "an Enter nobody took is not talk");
      assert.equal(messageDeliveryText(r.entry), NOT_SEEN);
    }],
    ["a dialog comes up", "dialog", (r) => {
      assert.equal(r.entry.delivered, true);
      assert.equal(r.entry.typedOnly, true);
      assert.match(r.entry.held, DIALOG);
      assert.equal(r.heard, 0, "an Enter that met a dialog is not talk");
      assert.match(messageDeliveryText(r.entry), DIALOG);
    }],
  ];

  for (const name of Object.keys(CLIS)) {
    for (const [what, afterEnter, check] of AFTER_ENTER) {
      test(`${name}: after Enter ${what}`, async () => {
        const pane = standIn(name, afterEnter);
        assert.equal(await paneHold(pane.id), null, "the idle composer is free");
        await reportThrough(pane, (r) => {
          assert.equal(pane.enters.length, 1, "Enter went to the pane");
          check(r);
        });
      });
    }
  }

  test("a turn that starts only after the window is not seen: the window is the limit", async () => {
    await reportThrough(standIn("claude", "started", WINDOW_MS + 500), (r) => {
      assert.equal(r.entry.held, NOT_SEEN);
      assert.equal(r.heard, 0);
    });
  });

  test("the next message to that pane names the one sitting in its composer", async () => {
    const pane = standIn("claude", "nothing");
    await reportThrough(pane, async (first, store, root) => {
      const next = await deliverAndLog(first.deps, { directory: root }, store, { team: "ux-review", from: "tester", to: "implementer", text: "round 6 ready" });
      assert.equal(pane.enters.length, 1, "the second one is not typed over the first");
      assert.equal(next.failure, `has text the user is typing; it may be message #${first.entry.id} from tester, typed there, not seen to start a turn: submit or clear it`);
    });
  });

  test("the output marks move on a pane's live output only, and start over when it exits", async () => {
    const { paneOutputMarks } = await import("../dist-electron/control.js");
    const marks = paneOutputMarks();
    const send = (event) => marks.sink.send("pty:event", event);
    send({ type: "data", ptyId: "a", chunk: "x" });
    send({ type: "data", ptyId: "a", chunk: "y", replay: true });
    send({ type: "data", ptyId: "b", chunk: "z" });
    assert.deepEqual([marks.mark("a"), marks.mark("b"), marks.mark("c")], [1, 1, 0]);
    send({ type: "exit", ptyId: "a", exitCode: 0 });
    assert.equal(marks.mark("a"), 0);
    assert.equal(marks.sink.isDestroyed(), false, "the host client keeps it for the app's life");
  });

  // Output alone is no proof where the composer can be read: Grok redraws all the time (measured: 187 chunks in 14 s idle).
  for (const name of ["claude", "grok"]) {
    test(`${name}: after Enter the pane keeps redrawing with the text still in its composer: not seen`, async () => {
      await reportThrough(standIn(name, "redraws", 200), (r) => {
        assert.equal(r.entry.held, NOT_SEEN);
        assert.equal(r.heard, 0);
      });
    });
  }

  test("a dialog drawn between the paste and Enter still withholds the Enter, with the turn check on", async () => {
    const pane = standIn("claude", "nothing", REACTS_MS, { dialogOnPaste: true });
    await reportThrough(pane, (r) => {
      assert.equal(pane.enters.length, 0, "no Enter on a dialog");
      assert.match(r.entry.held, /Enter not sent$/);
      assert.equal(r.heard, 0);
    });
  });

  test("Aya's text left unsent is a draft at once for the next read, not after the echo grace", async () => {
    const { settledAfterSubmit } = await import("../dist-electron/control.js");
    const pane = standIn("claude", "nothing");
    try {
      const hold = settledAfterSubmit((id, p) => paneHold(id, p), { graceMs: 2_000, pollMs: 15 });
      assert.equal(await deliverTeamMessage(pane.write, pane.id, "round 5 ready", hold, undefined, pane.probe), NOT_SEEN);
      const start = Date.now();
      assert.equal(await hold(pane.id), "has text the user is typing");
      assert.ok(Date.now() - start < 1_000, "not waited on as Aya's own echo");
    } finally {
      pane.close();
    }
  });

  // Measured: Grok 1.0.46 idle writes ~14 times a second (its animated logo), so output after Enter proves
  // nothing there; its boxed composer must be read as holding the paste.
  const grokRecorded = readFileSync(new URL("./fixtures/grok-screens/grok-1.0.46-idle.raw", import.meta.url), "utf8");

  /** The recorded Grok start screen; the paste drawn into its composer row; its logo animation going on after Enter. */
  function recordedGrok(clearOnEnter) {
    const id = `grok-rec-${(seq += 1)}`;
    const clock = fakeClock();
    let output = 0;
    const show = (data) => ((output += 1), writeVtPane(id, data));
    openVtPane(id, 120, 40, () => {}, "grok", false);
    show(grokRecorded);
    const tail = grokRecorded.slice(-4000);
    const write = async (_id, data) => {
      const pasted = PASTE.exec(data);
      const rows = screenRows(__testVtPane(id).terminal);
      const y = rows.findIndex((r) => /│ ❯/.test(r)) + 1;
      if (pasted) show(`\x1b[${y};7H${pasted[1]}`);
      else if (data === "\r") {
        for (let t = 70; t <= 2 * WINDOW_MS; t += 70) clock.at(t, () => show(tail));
        if (clearOnEnter) clock.at(200, () => show(`\x1b[${y};7H\x1b[K\x1b[${y};119H│`));
      }
    };
    const probe = { hold: paneHold, outputMark: () => output, outputPaused: () => false, windowMs: WINDOW_MS, sleep: clock.sleep };
    return { id, write, probe, enters: [], close: () => closeVtPane(id) };
  }

  for (const [label, clears, want] of [
    ["the composer keeps the text while the logo animates: not seen", false, NOT_SEEN],
    ["the composer empties: seen", true, null],
  ]) {
    test(`grok, recorded start screen | ${label}`, async () => {
      const pane = recordedGrok(clears);
      try {
        await sleep(30);
        assert.equal(await paneHold(pane.id), null, "the recorded idle composer is free");
        assert.equal(await deliverTeamMessage(pane.write, pane.id, "[team ux-review | from tester | 10:00] round 5 ready", (id, p) => paneHold(id, p), undefined, pane.probe), want);
      } finally {
        pane.close();
      }
    });
  }

  test("no composer to read and output that never paused before Enter: not seen, whatever comes after", async () => {
    const pane = standIn("other", "started");
    pane.probe.outputPaused = () => false;
    try {
      assert.equal(await deliverTeamMessage(pane.write, pane.id, "round 5 ready", (id, p) => paneHold(id, p), undefined, pane.probe), NOT_SEEN);
    } finally {
      pane.close();
    }
  });

  test("output marks: a pane paused lately once it was quiet for a moment within the last second", async () => {
    const { paneOutputMarks } = await import("../dist-electron/control.js");
    let now = 10_000;
    const marks = paneOutputMarks(() => now);
    const data = () => marks.sink.send("pty:event", { type: "data", ptyId: "a", chunk: "x" });
    data();
    now += 2_000;
    assert.equal(marks.outputPaused("a"), true, "quiet for 2 s");
    for (let i = 0; i < 30; i += 1) (now += 70), data();
    assert.equal(marks.outputPaused("a"), false, "writes every 70 ms for 2 s: never paused");
    now += 400;
    data();
    now += 70;
    assert.equal(marks.outputPaused("a"), true, "a 400 ms gap 70 ms ago");
    assert.equal(marks.outputPaused("never-wrote"), true);
  });

  test("the turn window is twice the echo grace, 6 s, looked at every 100 ms", async () => {
    const { SUBMIT_ECHO_GRACE_MS, TURN_START_WINDOW_MS } = await import("../dist-electron/control.js");
    assert.equal(SUBMIT_ECHO_GRACE_MS, 3_000);
    assert.equal(TURN_START_WINDOW_MS, 6_000);
    const slept = [];
    const probe = { hold: async () => null, outputMark: () => 0, outputPaused: () => false, sleep: async (ms) => void slept.push(ms) };
    assert.equal(await deliverTeamMessage(async () => true, "turn-default-window", "hi", undefined, undefined, probe), NOT_SEEN);
    assert.equal(slept.reduce((a, b) => a + b, 0), TURN_START_WINDOW_MS);
    assert.equal(slept.length, 60);
  });

  test("output marks: a gap of exactly OUTPUT_PAUSE_MS is a pause, and it counts for exactly OUTPUT_PAUSE_WITHIN_MS", async () => {
    const { paneOutputMarks, OUTPUT_PAUSE_MS, OUTPUT_PAUSE_WITHIN_MS } = await import("../dist-electron/control.js");
    assert.equal(OUTPUT_PAUSE_MS, 300);
    assert.equal(OUTPUT_PAUSE_WITHIN_MS, 1_000);
    let now = 10_000;
    const marks = paneOutputMarks(() => now);
    const data = () => marks.sink.send("pty:event", { type: "data", ptyId: "a", chunk: "x" });
    data();
    // Busy past the first write's window: 100 ms gaps are no pause.
    for (let t = 0; t <= OUTPUT_PAUSE_WITHIN_MS; t += 100) (now += 100), data();
    now += OUTPUT_PAUSE_MS - 1;
    assert.equal(marks.outputPaused("a"), false, "one ms short of a pause");
    now += 1;
    assert.equal(marks.outputPaused("a"), true, "quiet for exactly the pause");
    data();
    for (let t = 100; t <= OUTPUT_PAUSE_WITHIN_MS; t += 100) (now += 100), data();
    assert.equal(marks.outputPaused("a"), true, "the pause ended exactly the window ago");
    now += 1;
    assert.equal(marks.outputPaused("a"), false, "one ms past the window");
  });
});
