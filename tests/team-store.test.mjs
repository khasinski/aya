// A team's per-machine state in ~/.aya/teams/<project>/<team>/: role panes, the saved
// definition, and the message log with each role's read position.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamStore, openTeamStore, teamDir } from "../dist-electron/team-store.js";

const fresh = () => new TeamStore(mkdtempSync(join(tmpdir(), "aya-team-")));
const done = (store) => rmSync(store.dir, { recursive: true, force: true });
const logLine = (id, m) => `${JSON.stringify({ id, time: new Date(0).toISOString(), from: "a", to: "b", commit: null, text: "x", ...m })}\n`;
const writeLog = (store, lines) => writeFileSync(join(store.dir, "log.jsonl"), lines.join(""));

// Every filesystem case creates its own directory. Keep per-store races and
// their ordering inside each case; overlap work across independent stores.
describe("stores in independent directories", { concurrency: 16 }, () => {
  test("teamDir keeps each project's team apart under the aya home", () => {
    assert.equal(teamDir("/h/.aya", "game", "ux-review"), "/h/.aya/teams/game/ux-review");
    assert.equal(teamDir("/h/.aya", "e2e-proj", "ux-review"), "/h/.aya/teams/e2e-proj/ux-review");
  });

  test("a team's files on disk keep their names", async () => {
    const store = fresh();
    try {
      await store.assign("tester", "pane-a");
      await store.setPaused(true);
      await store.saveDefinition("# team");
      await store.append({ from: "user", to: "tester", text: "hi" });
      await store.markRead("tester", 1);
      assert.deepEqual(readdirSync(store.dir).sort(), [
        "assignments.json",
        "log.jsonl",
        "read.json",
        "saved.md",
        "state.json",
      ]);
    } finally {
      done(store);
    }
  });

  test("one pane per role; assigning a held role moves it", async () => {
    const store = fresh();
    try {
      await store.assign("tester", "pane-a");
      await store.assign("implementer", "pane-b");
      assert.equal(await store.paneOf("tester"), "pane-a");
      assert.equal(await store.roleOf("pane-b"), "implementer");
      await store.assign("tester", "pane-c");
      assert.equal(await store.paneOf("tester"), "pane-c");
      assert.equal(await store.roleOf("pane-a"), null);
    } finally {
      done(store);
    }
  });

  test("a pane holds one role: taking a second one gives up the first", async () => {
    const store = fresh();
    try {
      await store.assign("tester", "pane-a");
      await store.assign("implementer", "pane-a");
      assert.equal(await store.paneOf("tester"), null);
      assert.equal(await store.roleOf("pane-a"), "implementer");
    } finally {
      done(store);
    }
  });

  test("closing a pane frees its role", async () => {
    const store = fresh();
    try {
      await store.assign("tester", "pane-a");
      await store.releasePane("pane-a");
      assert.equal(await store.paneOf("tester"), null);
    } finally {
      done(store);
    }
  });

  test("assignments survive a new store on the same dir", async () => {
    const store = fresh();
    try {
      await store.assign("tester", "pane-a");
      assert.equal(await new TeamStore(store.dir).paneOf("tester"), "pane-a");
    } finally {
      done(store);
    }
  });

  test("the saved definition is kept verbatim", async () => {
    const store = fresh();
    try {
      assert.equal(await store.savedDefinition(), null);
      await store.saveDefinition("# ux-review\n");
      assert.equal(await store.savedDefinition(), "# ux-review\n");
    } finally {
      done(store);
    }
  });

  test("messages get increasing ids and the log is private", async () => {
    const store = fresh();
    try {
      const a = await store.append({ from: "tester", to: "implementer", commit: "a1b2c3d", text: "one", delivered: false });
      const b = await store.append({ from: "implementer", to: "tester", commit: null, text: "two", delivered: false });
      assert.equal(a.id, 1);
      assert.equal(b.id, 2);
      assert.match(a.time, /^\d{4}-\d\d-\d\dT/);
      assert.equal(statSync(join(store.dir, "log.jsonl")).mode & 0o777, 0o600);
    } finally {
      done(store);
    }
  });

  test("inbox shows a role's unread messages until it marks them read", async () => {
    const store = fresh();
    try {
      await store.append({ from: "tester", to: "implementer", commit: null, text: "one", delivered: false });
      await store.append({ from: "implementer", to: "tester", commit: null, text: "not yours", delivered: false });
      await store.append({ from: "tester", to: "implementer", commit: null, text: "two", delivered: false });
      const unread = await store.unread("implementer");
      assert.deepEqual(unread.map((m) => m.text), ["one", "two"]);
      await store.markRead("implementer", unread.at(-1).id);
      assert.deepEqual(await store.unread("implementer"), []);
      assert.equal((await store.unread("tester")).length, 1);
    } finally {
      done(store);
    }
  });

  test("a message typed into the pane is not repeated by the inbox", async () => {
    const store = fresh();
    try {
      await store.append({ from: "tester", to: "implementer", commit: null, text: "typed", delivered: true });
      await store.append({ from: "tester", to: "implementer", commit: null, text: "waiting", delivered: false });
      assert.deepEqual((await store.unread("implementer")).map((m) => m.text), ["waiting"]);
    } finally {
      done(store);
    }
  });

  test("concurrent appends never share an id", async () => {
    const store = fresh();
    try {
      const sent = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.append({ from: "tester", to: "implementer", commit: null, text: `m${i}`, delivered: false }),
        ),
      );
      assert.equal(new Set(sent.map((m) => m.id)).size, 20);
    } finally {
      done(store);
    }
  });

  test("a team runs only after Start and until Pause", async () => {
    const store = fresh();
    try {
      assert.equal((await store.state()).running, false);
      await store.setPaused(false);
      assert.equal((await store.state()).running, true);
      await store.setPaused(true);
      assert.deepEqual(await store.state(), { paused: true, running: false });
    } finally {
      done(store);
    }
  });

  test("the last round survives a new store and a pause; a hand-edited one that is not a count reads as none", async () => {
    const store = fresh();
    try {
      assert.equal(await store.lastRound(), 0);
      await store.recordRound(3);
      await store.setPaused(true);
      assert.equal(await new TeamStore(store.dir).lastRound(), 3);
      for (const bad of ["4", 2.5, -1, 0, null, 1e300]) {
        writeFileSync(join(store.dir, "state.json"), JSON.stringify({ paused: false, started: true, lastRound: bad }));
        assert.equal(await store.lastRound(), 0, `lastRound ${JSON.stringify(bad)}`);
      }
    } finally {
      done(store);
    }
  });

  test("two stores on one team share one write queue: ids never repeat", async () => {
    const a = fresh();
    const b = new TeamStore(a.dir);
    try {
      const sent = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? a : b).append({ from: "t", to: "i", commit: null, text: `m${i}`, delivered: false }),
        ),
      );
      assert.equal(new Set(sent.map((m) => m.id)).size, 10);
    } finally {
      done(a);
    }
  });

  test("a slower inbox never moves the read position back", async () => {
    const store = fresh();
    try {
      for (const text of ["a", "b", "c"]) await store.append({ from: "t", to: "i", commit: null, text, delivered: false });
      await store.markRead("i", 3);
      await store.markRead("i", 1);
      assert.deepEqual(await store.unread("i"), []);
    } finally {
      done(store);
    }
  });

  test("a team name that is not a slug never becomes a path", () => {
    assert.throws(() => teamDir("/h/.aya", "game", "../../etc"), /team name/);
    assert.throws(() => teamDir("/h/.aya", "../x", "ux"), /project/);
  });

  test("openTeamStore opens the store in the team's directory, refusing a bad name", () => {
    assert.equal(openTeamStore("/home/aya", "game", "ux-review").dir, teamDir("/home/aya", "game", "ux-review"));
    assert.throws(() => openTeamStore("/home/aya", "game", "../x"), /bad team name "\.\.\/x"/);
  });

  test("a torn or hand-edited log line is skipped, not fatal", async () => {
    const store = fresh();
    try {
      await store.append({ from: "tester", to: "implementer", commit: null, text: "one", delivered: false });
      const { appendFileSync } = await import("node:fs");
      appendFileSync(join(store.dir, "log.jsonl"), '{"id": 2, "from": "tes\nnot json\n');
      const next = await store.append({ from: "tester", to: "implementer", commit: null, text: "two", delivered: false });
      assert.equal(next.id, 2);
      assert.deepEqual((await store.unread("implementer")).map((m) => m.text), ["one", "two"]);
    } finally {
      done(store);
    }
  });

  test("the log keeps its newest messages once it grows past the cap; ids go on", async () => {
    const { TEAM_LOG_MAX_ENTRIES, TEAM_LOG_KEEP_ENTRIES } = await import("../dist-electron/team-store.js");
    const store = fresh();
    try {
      writeLog(store, Array.from({ length: TEAM_LOG_MAX_ENTRIES }, (_, i) => logLine(i + 1, { delivered: true })));
      const entry = await store.append({ from: "a", to: "b", commit: null, text: "new", delivered: false });
      assert.equal(entry.id, TEAM_LOG_MAX_ENTRIES + 1);
      const log = await store.log();
      assert.equal(log.length, TEAM_LOG_KEEP_ENTRIES);
      assert.equal(log.at(-1).id, entry.id);
      assert.equal(statSync(join(store.dir, "log.jsonl")).mode & 0o777, 0o600);
      assert.deepEqual((await store.unread("b")).map((m) => m.text), ["new"]);
    } finally {
      done(store);
    }
  });

  test("the round clock is a finite number; anything else in state.json counts as no clock", async () => {
    const store = fresh();
    try {
      // 1e999 parses to Infinity: a hand-edited clock that would make every wait zero.
      for (const [raw, expected] of [["1234", 1234], ["1e999", null], ['"12"', null], ["null", null], ["true", null]]) {
        writeFileSync(join(store.dir, "state.json"), `{"roundClockAt":${raw}}`);
        assert.equal(await store.roundClockAt(), expected, raw);
      }
    } finally {
      done(store);
    }
  });

  const WRITERS = {
    assign: (s) => s.assign("tester", "pane-a"),
    releasePane: (s) => s.releasePane("pane-a"),
    setPaused: (s) => s.setPaused(true),
    markAgentAuthored: (s) => s.markAgentAuthored(),
    recordRound: (s) => s.recordRound(3),
    setRoundClockAt: (s) => s.setRoundClockAt(Date.now()),
    saveDefinition: (s) => s.saveDefinition("# team"),
    append: (s) => s.append({ from: "user", to: "tester", text: "hi" }),
    markRead: (s) => s.markRead("tester", 1),
    beginTyping: (s) => s.beginTyping("tester", 1),
    endTyping: (s) => s.endTyping("tester"),
  };

  for (const [name, write] of Object.entries(WRITERS)) {
    test(`a store opened before Remove: ${name} is refused and recreates nothing`, async () => {
      const store = fresh();
      try {
        await store.markAgentAuthored();
        const opened = new TeamStore(store.dir);
        await new TeamStore(store.dir).remove();
        await assert.rejects(write(opened), /team was removed/);
        assert.equal(existsSync(store.dir), false);
      } finally {
        done(store);
      }
    });
  }

  test("recordRound sets the round and its clocks together and keeps the rest of the state", async () => {
    const store = fresh();
    try {
      await store.setPaused(false);
      await store.recordRound(4, { roundClockAt: 1234, silenceRoundAt: 1200 });
      assert.equal(await store.lastRound(), 4);
      assert.equal(await store.roundClockAt(), 1234);
      assert.equal(await store.silenceRoundAt(), 1200);
      await store.recordRound(5);
      assert.deepEqual([await store.lastRound(), await store.roundClockAt(), await store.silenceRoundAt()], [5, 1234, 1200], "a round that answers no clock leaves both");
      assert.equal((await store.state()).running, true);
    } finally {
      done(store);
    }
  });

  test("delivery notes keep the newest 500 per role; the oldest is dropped", async () => {
    const { DELIVERY_NOTES_KEEP } = await import("../dist-electron/team-store.js");
    assert.equal(DELIVERY_NOTES_KEEP, 500);
    const store = fresh();
    try {
      for (let id = 1; id <= DELIVERY_NOTES_KEEP + 1; id += 1) await store.noteDelivery("b", id, { kind: "inbox" });
      const ids = Object.keys(JSON.parse(readFileSync(join(store.dir, "delivery-notes.json"), "utf8")).b).map(Number);
      assert.equal(ids.length, DELIVERY_NOTES_KEEP);
      assert.deepEqual([Math.min(...ids), Math.max(...ids)], [2, DELIVERY_NOTES_KEEP + 1]);
    } finally {
      done(store);
    }
  });

  test("the log is read from its tail: a huge file costs a bounded read, the newest messages and ids stay right", async () => {
    const { TEAM_LOG_READ_BYTES, TEAM_LOG_TRIM_BYTES } = await import("../dist-electron/team-store.js");
    assert.equal(TEAM_LOG_TRIM_BYTES, TEAM_LOG_READ_BYTES / 2);
    const store = fresh();
    try {
      const text = "y".repeat(8000);
      const total = Math.ceil((TEAM_LOG_READ_BYTES * 3) / 8100);
      writeLog(store, Array.from({ length: total }, (_, i) => logLine(i + 1, { text, delivered: false })));
      const log = await store.log();
      assert.ok(log.length < total / 2, `read ${log.length} of ${total}`);
      assert.equal(log.at(-1).id, total);
      assert.ok(log.every((m) => m.text === text), "no torn first line");
      const entry = await store.append({ from: "a", to: "b", commit: null, text: "new", delivered: false });
      assert.equal(entry.id, total + 1);
      assert.equal((await store.unread("b")).at(-1).text, "new");
      assert.ok(statSync(join(store.dir, "log.jsonl")).size <= TEAM_LOG_TRIM_BYTES + 8100, "the append shrank the file to about half the read window");
    } finally {
      done(store);
    }
  });

  // A quiet role's unread message is not cut by the trim, however much the others talk.
  test("the trim keeps a message still owed to a quiet role; read ones and Aya's stale ones go", async () => {
    const { TEAM_LOG_MAX_ENTRIES, TEAM_LOG_READ_BYTES } = await import("../dist-electron/team-store.js");
    const OLD = {
      "owed to the quiet role": { msg: { from: "lead", to: "quiet", delivered: false }, read: false, kept: true },
      "already read by it": { msg: { from: "lead", to: "quiet", delivered: false }, read: true, kept: false },
      "Aya's held round": { msg: { from: "aya", to: "quiet", delivered: false }, read: false, kept: false },
    };
    const TRIMS = {
      "the entry cap": { count: TEAM_LOG_MAX_ENTRIES - 1, text: "x" },
      // just under the read window before the append, past it after
      "the byte window": { count: Math.floor(TEAM_LOG_READ_BYTES / 8150), text: "y".repeat(8000) },
    };
    for (const [trim, { count, text }] of Object.entries(TRIMS)) {
      for (const [old, { msg, read, kept }] of Object.entries(OLD)) {
        const store = fresh();
        try {
          const talk = Array.from({ length: count }, (_, i) => logLine(i + 2, { text, delivered: true }));
          writeLog(store, [logLine(1, { text: "the plan", ...msg }), ...talk]);
          if (read) await store.markRead("quiet", 1);
          await store.append({ from: "a", to: "b", commit: null, text, delivered: true });
          await store.append({ from: "a", to: "b", commit: null, text, delivered: true });
          const log = await store.log();
          assert.equal(log.some((m) => m.id === 1), kept, `${trim} | ${old}: in the log`);
          assert.ok(log.length < count + 1, `${trim} | ${old}: the log was trimmed`);
          assert.equal(log.at(-1).id, count + 3, `${trim} | ${old}: ids go on`);
          assert.equal((await store.owed("quiet")).some((m) => m.id === 1), kept && !read, `${trim} | ${old}: in its inbox`);
          assert.ok(statSync(join(store.dir, "log.jsonl")).size <= TEAM_LOG_READ_BYTES, `${trim} | ${old}: the file stays inside the read window`);
        } finally {
          done(store);
        }
      }
    }
  });

  test("a reservation's paste begins for the message reserved only: another id leaves it queued", async () => {
    const store = fresh();
    try {
      await store.append({ from: "tester", to: "implementer", commit: null, text: "one", delivered: false });
      await store.append({ from: "tester", to: "implementer", commit: null, text: "two", delivered: false });
      assert.equal(await store.beginTyping("implementer", 2), true);
      await store.typingBegan("implementer", 1);
      assert.equal((await store.readMarks()).implementer, 2);
      await store.endTyping("implementer");
    } finally {
      done(store);
    }
  });

  test("a message this process is pasting shows as typed, not as left by a crash", async () => {
    const store = fresh();
    try {
      await store.append({ from: "tester", to: "implementer", commit: null, text: "one", delivered: false });
      await store.beginTyping("implementer", 1);
      await store.typingBegan("implementer", 1);
      const [m] = await store.annotatedLog();
      assert.equal(m.held, undefined);
      assert.equal(m.delivered, true);
      await store.endTyping("implementer");
    } finally {
      done(store);
    }
  });

  test("removing a team a second store already removed is no error", async () => {
    const store = fresh();
    try {
      const other = new TeamStore(store.dir);
      await store.remove();
      await other.remove();
      await assert.rejects(other.append({ from: "tester", to: "implementer", commit: null, text: "late", delivered: false }), /team was removed/);
    } finally {
      done(store);
    }
  });

  test("a read window that starts exactly on a line keeps that line", async (t) => {
    const { TEAM_LOG_READ_BYTES } = await import("../dist-electron/team-store.js");
    const dir = mkdtempSync(join(tmpdir(), "aya-tail-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const line = (id, text) => JSON.stringify({ id, time: "2026-10-03T10:00:00.000Z", from: "tester", to: "implementer", text, delivered: true, commit: null }) + "\n";
    const pad = TEAM_LOG_READ_BYTES - line(2, "").length;
    writeFileSync(join(dir, "log.jsonl"), line(1, "older") + line(2, "x".repeat(pad)));
    assert.deepEqual((await new TeamStore(dir).log()).map((m) => m.id), [2]);
  });
});
