// Local, per-machine state of a team in ~/.aya/teams/<project>/<team>/:
// which pane plays which role, the definition the user last saved, and the
// message log with each role's read position.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamStore, teamDir } from "../dist-electron/team-store.js";

const fresh = () => new TeamStore(mkdtempSync(join(tmpdir(), "aya-team-")));
const done = (store) => rmSync(store.dir, { recursive: true, force: true });

test("teamDir keeps each project's team apart under the aya home", () => {
  assert.equal(teamDir("/h/.aya", "game", "ux-review"), "/h/.aya/teams/game/ux-review");
  assert.equal(teamDir("/h/.aya", "e2e-proj", "ux-review"), "/h/.aya/teams/e2e-proj/ux-review");
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
    assert.equal(await store.running(), false);
    await store.setPaused(false);
    assert.equal(await store.running(), true);
    await store.setPaused(true);
    assert.equal(await store.running(), false);
    assert.equal(await store.paused(), true);
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
