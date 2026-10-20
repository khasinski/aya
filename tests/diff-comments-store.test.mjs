import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, readFileSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addDiffComment,
  clearSentDiffComments,
  deleteDiffComment,
  diffCommentsFile,
  editDiffComment,
  listDiffComments,
  markDiffCommentsSent,
  sendDiffComments,
} from "../dist-electron/diff-comments-store.js";

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "aya-diff-comments-"));
  chmodSync(root, 0o700);
  return root;
};
const sample = (id, note = "Check this line") => ({
  id, file: "src/a.ts", hunk: "@@ -1 +1 @@", line: "+new", newLine: 1,
  oldLine: null, occurrence: 0, checkout: "/work/project", note,
  createdAt: "2026-10-20T00:00:00.000Z", sentAt: null, sentTo: null,
});

test("comments persist across a fresh read, stay per project, and sent comments remain until cleared", async (t) => {
  const home = makeRoot();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(await listDiffComments(home, "project-a"), []);
  await addDiffComment(home, "project-a", sample("0123456789abcdef"));
  // A fresh call models a renderer reload or Aya restart.
  assert.deepEqual(await listDiffComments(home, "project-a"), [sample("0123456789abcdef")]);
  assert.deepEqual(await listDiffComments(home, "project-b"), []);
  await markDiffCommentsSent(home, "project-a", ["0123456789abcdef"], "reviewer");
  const sent = await listDiffComments(home, "project-a");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sentTo, "reviewer");
  assert.ok(sent[0].sentAt);
  const editedSent = await editDiffComment(home, "project-a", sent[0].id, "changed");
  assert.equal(editedSent[0].note, "changed");
  assert.equal(editedSent[0].sentAt, null);
  await markDiffCommentsSent(home, "project-a", [sent[0].id], "reviewer");
  assert.deepEqual(await clearSentDiffComments(home, "project-a"), []);
  await addDiffComment(home, "project-a", sample("1123456789abcdef"));
  assert.equal((await deleteDiffComment(home, "project-a", "1123456789abcdef")).length, 0);
  const file = diffCommentsFile(home, "project-a");
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).projectSlug, "project-a");
});

test("unsafe comment paths and malformed or oversized records fail closed", async (t) => {
  const home = makeRoot();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.throws(() => diffCommentsFile(home, "../escape"), /Invalid project/);
  const target = join(home, "outside.json");
  const folder = join(home, "diff-comments");
  (await import("node:fs")).mkdirSync(folder, { mode: 0o700 });
  symlinkSync(target, join(folder, "project.json"));
  await assert.rejects(listDiffComments(home, "project"), /could not read|unsafe/);
});

test("editing and deleting only affect the selected unsent comment", async (t) => {
  const home = makeRoot();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await addDiffComment(home, "project", sample("0123456789abcdef", "first"));
  await addDiffComment(home, "project", sample("1123456789abcdef", "second"));
  const edited = await editDiffComment(home, "project", "0123456789abcdef", "updated");
  assert.deepEqual(edited.map((c) => c.note), ["updated", "second"]);
  const after = await deleteDiffComment(home, "project", "1123456789abcdef");
  assert.deepEqual(after.map((c) => c.note), ["updated"]);
});

test("delivery failure keeps comments unsent and concurrent sends deliver a batch only once", async (t) => {
  const home = makeRoot();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = "2123456789abcdef";
  await addDiffComment(home, "project", sample(id));
  await assert.rejects(sendDiffComments(home, "project", [id], "reviewer", async () => {
    throw new Error("The pane is waiting for your choice.");
  }), /waiting for your choice/);
  assert.equal((await listDiffComments(home, "project"))[0].sentAt, null);

  let delivered = 0;
  const deliver = async (comments) => {
    delivered += 1;
    assert.equal(comments[0].id, id);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const results = await Promise.allSettled([
    sendDiffComments(home, "project", [id], "reviewer", deliver),
    sendDiffComments(home, "project", [id], "reviewer", deliver),
  ]);
  assert.equal(delivered, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.ok((await listDiffComments(home, "project"))[0].sentAt);
});
