// Right after Aya's Enter, Claude has not yet redrawn its composer, which still shows Aya's own line: no draft.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";
import { fixture } from "./helpers/vt-screens.mjs";

const { deliverTeamMessage, settledAfterSubmit } = await import("../dist-electron/control.js");
const { deliverAndLog } = await import("../dist-electron/team-control.js");
const { TeamStore } = await import("../dist-electron/team-store.js");

const IDLE = readFileSync(new URL("./fixtures/claude-idle-composer.raw", import.meta.url), "utf8");
const REAL_ROW = "\x1b[7m \r";
const INV = (s) => `\x1b[7m${s}\x1b[27m`;
const withRow = (row) => IDLE.replace(REAL_ROW, `${row}\r`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
const DRAFT = "has text the user is typing";
// 80 ms redraws still finish well inside this explicit test override.
const FAST = { graceMs: 300, pollMs: 15 };
let seq = 0;

/** A Claude stand-in: the paste shows in the composer, Enter clears it `clearMs` later (never: null). */
function claudePane({ clearMs }) {
  const id = `echo-${(seq += 1)}`;
  openVtPane(id, 120, 30, () => {}, "claude", false);
  writeVtPane(id, IDLE);
  const write = async (_id, data) => {
    const m = PASTE.exec(data);
    if (m) writeVtPane(id, withRow(m[1] + INV(" ")));
    else if (data === "\r" && clearMs !== null) setTimeout(() => writeVtPane(id, IDLE), clearMs);
  };
  return { id, write, close: () => closeVtPane(id) };
}

async function ready(id) {
  await sleep(40);
  assert.equal(await paneHold(id), null, "the idle composer is free");
}

const hold = (id) => settledAfterSubmit((tid, pasted) => paneHold(tid, pasted), FAST);

// [name, clearMs, what happens right after Aya's Enter, expected hold read right after]
const TABLE = [
  ["Aya's line still in the composer 80 ms after its Enter: free once Claude redraws", 80, null, null],
  ["Aya's line cleared before the read: free", 0, null, null],
  ["Aya's line never leaves the composer (Enter swallowed): still held as a draft", null, null, DRAFT],
  ["Aya's line in flight and the user appends to it: a draft at once", 80, " and more", DRAFT],
];

// Each case owns its pane and store, so independent panes can wait for redraws together under FAST's grace.
describe("submit echoes on independent panes", { concurrency: 8 }, () => {
  for (const [name, clearMs, userAdds, expected] of TABLE) {
    test(name, async () => {
      const pane = claudePane({ clearMs });
      try {
        await ready(pane.id);
        await deliverTeamMessage(pane.write, pane.id, "Delivery test: run aya team whoami", (id, p) => paneHold(id, p));
        if (userAdds) writeVtPane(pane.id, withRow("Delivery test: run aya team whoami" + userAdds + INV(" ")));
        const start = Date.now();
        const read = await hold(pane.id)(pane.id);
        assert.equal(read, expected);
        if (userAdds) assert.ok(Date.now() - start < 300, "a real draft is reported at once, not after the grace");
      } finally {
        pane.close();
      }
    });
  }

  test("a user draft with no send from Aya is held at once, not waited on", async () => {
    const pane = claudePane({ clearMs: 0 });
    try {
      await ready(pane.id);
      writeVtPane(pane.id, withRow("half typed" + INV(" ")));
      await sleep(40);
      const start = Date.now();
      assert.equal(await hold(pane.id)(pane.id), DRAFT);
      assert.ok(Date.now() - start < 300, "no wait without an echo of Aya's own");
    } finally {
      pane.close();
    }
  });

  test("the user types the same words long after Aya's send: a draft once the grace has passed", async () => {
    const pane = claudePane({ clearMs: 0 });
    try {
      await ready(pane.id);
      await deliverTeamMessage(pane.write, pane.id, "same words", (id, p) => paneHold(id, p));
      await sleep(60);
      await sleep(FAST.graceMs);
      writeVtPane(pane.id, withRow("same words" + INV(" ")));
      await sleep(40);
      assert.equal(await hold(pane.id)(pane.id), DRAFT);
    } finally {
      pane.close();
    }
  });

  test("Start's shape: the delivery test, then the task to the same pane right after its Enter: both typed, none held", async () => {
    const pane = claudePane({ clearMs: 80 });
    const root = mkdtempSync(join(tmpdir(), "aya-own-echo-"));
    try {
      await ready(pane.id);
      const store = new TeamStore(join(root, "team"));
      await store.assign("reviewer", pane.id);
      const deps = {
        deliver: (tid, text) => deliverTeamMessage(pane.write, tid, text, hold(pane.id)),
        holdReason: hold(pane.id),
        headCommit: async () => "abc1234",
      };
      const send = (from, text) => deliverAndLog(deps, { directory: root }, store, { team: "t", from, to: "reviewer", text });
      const first = await send("aya", "Delivery test: run aya team whoami");
      const task = await send("user", "do the three functions");
      assert.equal(first.failure, null);
      assert.equal(task.failure, null, "the task must not be held on Aya's own line");
      assert.equal(task.entry.held, undefined);
    } finally {
      pane.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The composer showing exactly Aya's line is not a draft; anything else there is.
  const OC_DRAFT = fixture("opencode-draft.screen.txt");
  const WRAPPED = ["❯ aaaa bbbb cccc dddd", "  eeee ffff"];

  async function holdWith(agent, rows, pasted) {
    const id = `echo-table-${++seq}`;
    openVtPane(id, 100, 30, () => {}, agent, false);
    try {
      writeVtPane(id, "\x1b[2J\x1b[H" + rows.join("\r\n"));
      await sleep(30);
      return await paneHold(id, pasted);
    } finally {
      closeVtPane(id);
    }
  }

  // [name, agent, rows, pasted, expected]
  const PASTED_TABLE = [
    ["claude: only Aya's line", "claude", ["❯ hello there"], "hello there", null],
    ["claude: Aya's line plus the user's words", "claude", ["❯ hello there and more"], "hello there", DRAFT],
    ["claude: the user's words before Aya's line", "claude", ["❯ more hello there"], "hello there", DRAFT],
    ["claude: a different draft", "claude", ["❯ half typed"], "hello there", DRAFT],
    ["claude: Aya's line wrapped over two rows", "claude", WRAPPED, "aaaa bbbb cccc dddd eeee ffff", null],
    ["claude: wrapped Aya's line plus the user's words on its last row", "claude", ["❯ aaaa bbbb cccc dddd", "  eeee ffff gggg"], "aaaa bbbb cccc dddd eeee ffff", DRAFT],
    ["claude: the same line as an older prompt row above an empty composer", "claude", ["❯ hello there", "● Done.", "❯ "], "hello there", null],
    ["claude: the same line above a different draft", "claude", ["❯ hello there", "● Done.", "❯ my own words"], "hello there", DRAFT],
    ["codex: only Aya's line", "codex", ["› hello there", "  GPT-6 medium"], "hello there", null],
    ["codex: Aya's line plus the user's words", "codex", ["› hello there!!", "  GPT-6 medium"], "hello there", DRAFT],
    ["opencode: only Aya's line", "opencode", OC_DRAFT, "half typed text", null],
    ["opencode: a prefix of the draft", "opencode", OC_DRAFT, "half", DRAFT],
  ];
  for (const [name, agent, rows, pasted, expected] of PASTED_TABLE) {
    test(`paneHold with Aya's line, ${name}`, async () => {
      assert.equal(await holdWith(agent, rows, pasted), expected);
      if (expected === null) assert.equal(await holdWith(agent, rows, undefined), DRAFT_OR_FREE(rows), "without the line it is still read as a draft");
    });
  }
  function DRAFT_OR_FREE(rows) {
    return rows.at(-1) === "❯ " ? null : DRAFT;
  }

  test("a read that names its own paste is answered at once, not waited out as Aya's echo", async () => {
    const id = `echo-${(seq += 1)}`;
    await deliverTeamMessage(async () => true, id, "first", async () => null);
    const composer = async (_id, pasted) => (pasted === "next" ? DRAFT : null);
    assert.equal(await settledAfterSubmit(composer, FAST)(id, "next"), DRAFT);
  });
});
