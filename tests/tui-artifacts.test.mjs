import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiArtifactStore, describeArtifact } from "../dist-electron/tui-artifacts.js";
import { parseControlRequest } from "../dist-electron/control-protocol.js";

test("present stores each kind, update keeps the id and bumps the revision", async () => {
  const store = new TuiArtifactStore();
  const a = await store.present({ kind: "metric", title: "Users", value: "42", description: "daily" }, "t1");
  assert.equal(a.updated, false);
  assert.equal(a.stored.artifact.revision, 1);
  const b = await store.present({ kind: "metric", title: "Users", value: "43", description: "daily", artifactId: a.stored.artifact.id }, "t1");
  assert.equal(b.updated, true);
  assert.equal(b.stored.artifact.id, a.stored.artifact.id);
  assert.equal(b.stored.artifact.revision, 2);
  assert.equal(b.stored.artifact.value, "43");
  assert.match(describeArtifact(b.stored), /metric {2}r2 {2}Users/);
  const table = await store.present({ kind: "table", title: "T", columns: ["a", "b"], rows: [["1", "2"]] }, "t1");
  assert.equal(table.stored.artifact.kind, "table");
  const html = await store.present({ kind: "html", title: "H", html: "<p>x</p>" }, "t1");
  assert.equal(html.stored.artifact.kind, "html");
});

test("a table with a ragged row, an empty html and an unknown id are refused", async () => {
  const store = new TuiArtifactStore();
  await assert.rejects(store.present({ kind: "table", title: "T", columns: ["a", "b"], rows: [["1"]] }, "t1"), /Invalid artifact/);
  await assert.rejects(store.present({ kind: "html", title: "H", html: "  " }, "t1"), /HTML widgets require/);
  await assert.rejects(store.present({ kind: "metric", title: "M", value: "1", artifactId: "nope" }, "t1"), /no artifact "nope"/);
});

test("images must be real images; another pane cannot update, list shows only the pane's own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-art-"));
  writeFileSync(join(dir, "fake.png"), "not an image");
  const store = new TuiArtifactStore();
  await assert.rejects(store.present({ kind: "image", title: "I", imagePath: join(dir, "fake.png") }, "t1"), /Supported images/);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)]);
  writeFileSync(join(dir, "ok.png"), png);
  const img = await store.present({ kind: "image", title: "I", imagePath: join(dir, "ok.png") }, "t1");
  assert.match(img.stored.artifact.dataUrl, /^data:image\/png;base64,/);
  await assert.rejects(store.present({ kind: "image", title: "I", imagePath: join(dir, "ok.png"), artifactId: img.stored.artifact.id }, "t2"), /another pane/);
  await store.present({ kind: "metric", title: "M", value: "1" }, "t2");
  assert.equal(store.list("t1").length, 1);
  assert.equal(store.list("t2").length, 1);
  assert.equal(store.list().length, 2);
  store.forget("t1");
  assert.equal(store.list().length, 1);
});

test("the store is capped, oldest first out", async () => {
  const store = new TuiArtifactStore(3);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await store.present({ kind: "metric", title: `m${i}`, value: "1" }, "t")).stored.artifact.id);
  assert.deepEqual(store.list("t").map((i) => i.artifact.id), ids.slice(2).reverse());
});

test("artifact requests parse", () => {
  const ok = parseControlRequest({ type: "artifact-present", input: { kind: "table", title: "T", columns: ["a"], rows: [["1"]], artifactId: "x" }, open: false });
  assert.equal(ok.open, false);
  assert.deepEqual(ok.input.rows, [["1"]]);
  assert.equal(parseControlRequest({ type: "artifact-present", input: { kind: "metric", title: "M", value: "1" } }).open, true);
  assert.throws(() => parseControlRequest({ type: "artifact-present", input: { kind: "pdf", title: "M" } }), /kind/);
  assert.throws(() => parseControlRequest({ type: "artifact-present", input: { kind: "metric" } }), /title/);
  assert.throws(() => parseControlRequest({ type: "artifact-open" }), /artifactId/);
  assert.equal(parseControlRequest({ type: "artifact-list", json: true }).json, true);
});
