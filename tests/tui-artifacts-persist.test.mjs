// TUI artifacts kept on disk per pane (electron/tui-artifacts.ts), the pane header's IPC (ipc/tui-artifacts-ipc.ts)
// and the header list's merge (components/TuiArtifactsButton.tsx).
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "aya-tui-art-"));
process.env.AYA_HOME = join(home, "aya");
after(() => rm(home, { recursive: true, force: true }));
const { TuiArtifactStore, paneTuiArtifacts, tuiArtifactStore, DEFAULT_TUI_ARTIFACTS_DIR } = await import("../dist-electron/tui-artifacts.js");
const { registerTuiArtifactsIpc } = await import("../dist-electron/ipc/tui-artifacts-ipc.js");
const { withArtifact } = await import("../dist-test/components/TuiArtifactsButton.js");

const metric = (title, value = "1", artifactId) => ({ kind: "metric", title, value, description: "d", ...(artifactId ? { artifactId } : {}) });
let dirs = 0;
const freshDir = () => join(home, `store-${dirs++}`);

test("a pane's artifacts survive a restart, revisions and order included; panes stay apart", async () => {
  const dir = freshDir();
  let clock = 1000;
  const first = new TuiArtifactStore({ dir, now: () => clock++ });
  const a = (await first.present(metric("A"), "t1")).stored.artifact;
  await first.present(metric("B"), "t1");
  await first.present(metric("A", "2", a.id), "t1");
  await first.present({ kind: "table", title: "T", columns: ["x"], rows: [["1"]] }, "t2");
  await first.present(metric("outside"));
  await first.flush();
  assert.equal((await readdir(dir)).length, 2, "one file per pane; an artifact from outside any pane is not kept");
  const second = new TuiArtifactStore({ dir });
  await second.load();
  assert.deepEqual(second.list("t1").map((i) => [i.artifact.title, i.artifact.revision]), [["A", 2], ["B", 1]]);
  assert.deepEqual(second.list("t2").map((i) => i.artifact.kind), ["table"]);
  // Updating a kept artifact after the restart keeps its id and bumps its revision.
  const again = await second.present(metric("A", "3", a.id), "t1");
  assert.equal(again.stored.artifact.revision, 3);
  await assert.rejects(second.present(metric("A", "4", a.id), "t2"), /another pane/);
});

test("on disk a pane keeps its newest artifacts within the count and byte limits", async () => {
  const dir = freshDir();
  const store = new TuiArtifactStore({ dir, perPane: 3, fileLimit: 1500 });
  for (let i = 0; i < 5; i++) await store.present(metric(`m${i}`), "t");
  await store.present({ kind: "html", title: "big", html: `<p>${"x".repeat(1200)}</p>` }, "t");
  await store.flush();
  assert.equal(store.list("t").length, 6, "memory keeps them all");
  const reread = new TuiArtifactStore({ dir });
  await reread.load();
  // The 1.2 kB widget plus two metrics would pass 1500 bytes, so the oldest go first.
  const kept = reread.list("t").map((i) => i.artifact.title);
  assert.equal(kept[0], "big");
  assert.ok(kept.length < 3 && kept.length >= 1, String(kept));
});

test("a damaged or foreign file is skipped, an invalid artifact is dropped, forget deletes the file", async () => {
  const dir = freshDir();
  const store = new TuiArtifactStore({ dir });
  const good = (await store.present(metric("good"), "t1")).stored.artifact;
  await store.flush();
  const [name] = await readdir(dir);
  const file = JSON.parse(await readFile(join(dir, name), "utf8"));
  file.items.push({ artifact: { id: "bad", kind: "image", title: "x", path: "a.png", dataUrl: "javascript:alert(1)" }, updatedAt: 1 });
  await writeFile(join(dir, name), JSON.stringify(file));
  await writeFile(join(dir, "0".repeat(64) + ".json"), "{not json");
  // A file whose name is not its pane's: someone else's, never loaded.
  await writeFile(join(dir, "1".repeat(64) + ".json"), JSON.stringify({ terminalId: "t9", items: file.items }));
  const reread = new TuiArtifactStore({ dir });
  await reread.load();
  assert.deepEqual(reread.list().map((i) => i.artifact.id), [good.id]);
  await reread.forget("t1");
  assert.ok(!(await readdir(dir)).includes(name));
});

test("prune drops panes that are gone only once their artifacts are old", async () => {
  const dir = freshDir();
  let clock = Date.now();
  const store = new TuiArtifactStore({ dir, now: () => clock });
  await store.present(metric("live"), "live");
  await store.present(metric("gone"), "gone");
  await store.flush();
  await store.prune(new Set(["live"]));
  assert.equal(store.list("gone").length, 1, "a recent artifact of a pane missing from the list stays");
  clock += 8 * 24 * 60 * 60 * 1000;
  await store.prune(new Set(["live"]));
  assert.equal(store.list("gone").length, 0);
  assert.equal(store.list("live").length, 1);
  // A stray old file nobody loaded goes too.
  const stray = join(dir, "2".repeat(64) + ".json");
  await writeFile(stray, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(stray, old, old);
  await store.prune(new Set(["live"]));
  assert.deepEqual((await readdir(dir)).length, 1);
});

test("paneTuiArtifacts gives the shared store's pane artifacts, full content, newest first", async () => {
  const store = tuiArtifactStore();
  assert.equal(DEFAULT_TUI_ARTIFACTS_DIR, join(home, "aya", "tui-artifacts"));
  await store.present(metric("one"), "pane-x");
  await store.present({ kind: "table", title: "two", columns: ["a"], rows: [["b"]] }, "pane-x");
  await store.present(metric("other"), "pane-y");
  const got = await paneTuiArtifacts("pane-x");
  assert.deepEqual(got.map((a) => a.title), ["two", "one"]);
  assert.deepEqual(got[0].rows, [["b"]]);
  await store.flush();
});

test("IPC lists summaries, opens only the pane's own and broadcasts each change with opened", async () => {
  const handlers = new Map(), sent = [], shown = [];
  const store = new TuiArtifactStore();
  registerTuiArtifactsIpc({ ipcMain: { handle: (c, h) => handlers.set(c, h) }, store, show: (a) => shown.push(a.id), broadcast: (c) => sent.push(c) });
  const a = (await store.present(metric("A"), "p1", true)).stored.artifact;
  await store.present(metric("A", "2", a.id), "p1", false);
  await store.present(metric("free"));
  assert.deepEqual(sent.map((c) => [c.terminalId, c.artifact.revision, c.updated, c.opened]), [["p1", 1, false, true], ["p1", 2, true, false]]);
  const list = await handlers.get("tui-artifacts:list")({}, "p1");
  assert.deepEqual(list.map((s) => [s.id, s.kind, s.title, s.revision]), [[a.id, "metric", "A", 2]]);
  assert.equal("value" in list[0], false);
  await handlers.get("tui-artifacts:open")({}, "p1", a.id);
  assert.deepEqual(shown, [a.id]);
  await assert.rejects(handlers.get("tui-artifacts:open")({}, "p2", a.id), /no artifact/);
});

test("the header list puts a new or updated artifact on top, once", () => {
  const s = (id, revision = 1) => ({ id, kind: "metric", title: id, revision, updatedAt: 0 });
  assert.deepEqual(withArtifact([s("b"), s("a")], s("a", 2)).map((a) => [a.id, a.revision]), [["a", 2], ["b", 1]]);
  assert.deepEqual(withArtifact([], s("c")).map((a) => a.id), ["c"]);
});
