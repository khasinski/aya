// A message is pasted, Enter pressed, and only then marked read: a crash or failed Enter in between must never type
// it twice, and a message that was not typed stays owed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest, PaneHeldError, TextPastedError, typedTeamMessage } = await import("../dist-electron/team-control.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;

async function world() {
  const { teamHome, project, cleanup } = teamProject("aya-typing-", { teamFile: TEAM });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  await store.setPaused(false);
  const w = { typed: [], failWith: null, afterTyping: null };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    // As main's: `pasting` once the pane lock is held and nothing holds the pane, then the paste.
    deliver: async (pane, text, _cancelled, _entered, pasting) => {
      if (w.failWith?.before) throw w.failWith.before;
      await pasting?.();
      w.typed.push({ pane, text });
      w.afterTyping?.();
      if (w.failWith?.after) throw w.failWith.after;
    },
    holdReason: async () => null,
    headCommit: async () => null,
  };
  const runner = () => new TeamRunner(w.deps, () => () => {});
  const held = (text) => store.append({ from: "tester", to: "implementer", commit: null, text, delivered: false, held: "shows an approval prompt" });
  const copies = (text) => w.typed.filter((t) => t.text.endsWith(text)).length;
  /** The disk as it was when `afterTyping` ran: what a crash right then leaves. */
  const crashAfterTyping = () => {
    const snap = join(teamHome, "snapshot");
    w.afterTyping = () => {
      rmSync(snap, { recursive: true, force: true });
      cpSync(store.dir, snap, { recursive: true });
    };
    return () => {
      for (const f of readdirSync(store.dir)) rmSync(join(store.dir, f), { force: true });
      for (const f of readdirSync(snap)) writeFileSync(join(store.dir, f), readFileSync(join(snap, f)));
    };
  };
  return Object.assign(w, { store, runner, held, copies, crashAfterTyping, cleanup });
}

const typingTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const w = await world(...args);
    try {
      await fn(w);
    } finally {
      w.cleanup();
    }
  });
};

typingTest("a crash after the text was typed but before the read mark: the relaunch does not type it again", async (w) => {
  await w.held("report");
  const crash = w.crashAfterTyping();
  assert.equal(await w.runner().redeliverWaiting(), 1);
  crash();
  assert.equal(await w.runner().redeliverWaiting(), 0);
  assert.equal(w.copies("report"), 1);
});

typingTest("a crash after the first of two held messages was typed: the relaunch types only the second", async (w) => {
  await w.held("first");
  await w.held("second");
  const crash = w.crashAfterTyping();
  assert.equal(await w.runner().redeliverWaiting(), 1);
  crash();
  w.afterTyping = null;
  assert.equal(await w.runner().redeliverWaiting(), 1);
  assert.equal(await w.runner().redeliverWaiting(), 0);
  assert.deepEqual([w.copies("first"), w.copies("second")], [1, 1]);
});

typingTest("Enter fails after the paste (redelivery): the draft is not typed again", async (w) => {
  await w.held("report");
  w.failWith = { after: new TextPastedError("pane exited before the text was submitted") };
  assert.equal(await w.runner().redeliverWaiting(), 0);
  w.failWith = null;
  assert.equal(await w.runner().redeliverWaiting(), 0);
  assert.equal(w.copies("report"), 1);
});

typingTest("Enter fails after the paste (aya team send): the send is refused, and the draft is not typed again", async (w) => {
  w.failWith = { after: new TextPastedError("pane exited before the text was submitted") };
  await assert.rejects(handleTeamRequest({ type: "team-send", role: "implementer", text: "report" }, "pane-t", w.deps), /implementer: typed, but Enter did not go through/);
  w.failWith = null;
  assert.equal(await w.runner().redeliverWaiting(), 0);
  assert.equal(w.copies("report"), 1);
});

test("Enter fails after the paste: the entry is logged as typed-only, and the next send names it as the draft", async () => {
  const { HOLD_DRAFT } = await import("../dist-electron/pane-holds.js");
  const w = await world();
  try {
    w.failWith = { after: new TextPastedError("pane exited before the text was submitted") };
    await assert.rejects(handleTeamRequest({ type: "team-send", role: "implementer", text: "report" }, "pane-t", w.deps));
    const [entry] = await w.store.annotatedLog();
    assert.equal(entry.typedOnly, true);
    assert.equal(entry.delivered, true, "not owed to redelivery");
    w.failWith = null;
    w.deps.holdReason = async () => HOLD_DRAFT;
    await assert.rejects(
      handleTeamRequest({ type: "team-send", role: "implementer", text: "next" }, "pane-t", w.deps),
      new RegExp(`it may be message #${entry.id} from tester, typed there, but Enter did not go through`),
    );
  } finally {
    w.cleanup();
  }
});

for (const [name, error] of [
  ["the pane became held", new PaneHeldError("shows an approval prompt")],
  ["the pane refused the text", new Error("pane did not accept the text")],
]) {
  typingTest(`nothing was typed (${name}): the message stays owed and goes out once later`, async (w) => {
    await w.held("report");
    w.failWith = { before: error };
    assert.equal(await w.runner().redeliverWaiting(), 0);
    assert.equal(w.copies("report"), 0);
    assert.equal((await w.store.unread("implementer")).length, 1, "still unread");
    w.failWith = null;
    assert.equal(await w.runner().redeliverWaiting(), 1);
    assert.equal(await w.runner().redeliverWaiting(), 0);
    assert.equal(w.copies("report"), 1);
  });
}

typingTest("aya team inbox prints a held message as it would have been typed: its id, then the typed line with its commit", async (w) => {
  const entry = await w.store.append({ from: "tester", to: "implementer", commit: "abc1234", text: "the report\nyou asked for", delivered: false });
  const { output } = await handleTeamRequest({ type: "team-inbox" }, "pane-i", w.deps);
  assert.equal(output, `#${entry.id} ${typedTeamMessage("ux-review", "tester", entry.time, "abc1234", "the report\nyou asked for")}\n`);
  assert.match(output, /^#\d+ \[team ux-review \| from tester \| \d\d:\d\d \| abc1234\] the report you asked for\n$/);
});

// A held message read through the inbox is talk, as it would have been typed at once.
for (const [name, text, talk] of [["says more than an ack", "the report you asked for", true], ["is only an ack", "ok", false]]) {
  typingTest(`a held peer message read through aya team inbox ${name}: ${talk ? "talk" : "nothing"}`, async (w) => {
    await w.store.updateProgress((p) => ({ ...p, changedAt: "2026-09-30T10:00:00.000Z", messages: 0 }));
    await w.held(text);
    const { output } = await handleTeamRequest({ type: "team-inbox" }, "pane-i", w.deps);
    assert.match(output, new RegExp(text));
    assert.equal((await w.store.unread("implementer")).length, 0, "read through the inbox");
    assert.equal((await w.store.log()).find((m) => m.text === text).delivered, false, "the log keeps the message as it was sent");
    const progress = await w.store.progress();
    assert.equal(progress.messages, talk ? 1 : 0);
    assert.equal(progress.stalledLogged, false);
    assert.equal(progress.changedAt !== "2026-09-30T10:00:00.000Z", talk, "changedAt moves when the message is talk");
  });
}

test("aya team inbox: a progress write that throws does not fail the read, and the messages are read once", async () => {
  const w = await world();
  const update = TeamStore.prototype.updateProgress;
  const warn = console.warn;
  const warnings = [];
  try {
    await w.held("the report you asked for");
    TeamStore.prototype.updateProgress = async () => {
      throw new Error("disk full");
    };
    console.warn = (...args) => warnings.push(args);
    const first = await handleTeamRequest({ type: "team-inbox" }, "pane-i", w.deps);
    assert.match(first.output, /the report you asked for/);
    assert.equal((await w.store.unread("implementer")).length, 0);
    assert.equal(warnings.length, 1, "one log line");
    assert.ok(warnings[0].every((a) => !(a instanceof Error)), "no stack");
    assert.match((await handleTeamRequest({ type: "team-inbox" }, "pane-i", w.deps)).output, /no unread/);
  } finally {
    TeamStore.prototype.updateProgress = update;
    console.warn = warn;
    w.cleanup();
  }
});

typingTest("aya team inbox: a message already typed, or Aya's own held round, is not progress (and Aya's stale round is marked read, not printed)", async (w) => {
  await w.store.updateProgress((p) => ({ ...p, changedAt: "2026-09-30T10:00:00.000Z", messages: 0 }));
  await w.store.append({ from: "tester", to: "implementer", commit: null, text: "typed earlier and long enough", delivered: true });
  await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Round 3: run your round as the team protocol says.", delivered: false, held: "is busy working" });
  const { output } = await handleTeamRequest({ type: "team-inbox" }, "pane-i", w.deps);
  assert.doesNotMatch(output, /Round 3/);
  assert.match(output, /no unread/);
  assert.equal((await w.store.unread("implementer")).length, 0, "the stale round is read, so it is not offered again");
  const progress = await w.store.progress();
  assert.deepEqual([progress.changedAt, progress.messages], ["2026-09-30T10:00:00.000Z", 0]);
});
