// Echo suppression for the config watcher. The contract: a watch
// event is an "echo" only if the file's content is byte-identical to the last
// thing Aya wrote to that path. Anything else — a never-written path, changed
// content, superseded content — is treated as an external edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashConfig,
  isEcho,
  recordWrite,
} from "../dist-electron/config-echo.js";
import { writeFileAtomic } from "../dist-electron/atomic-write.js";

test("isEcho is true only for the exact content last written to that path", () => {
  const p = "/tmp/aya-echo-test/snippets.json";
  recordWrite(p, '{"snippets":[]}');
  assert.equal(isEcho(p, '{"snippets":[]}'), true); // our own write
  assert.equal(isEcho(p, '{"snippets":[{"id":"x"}]}'), false); // external edit
});

test("isEcho is false for a path we never wrote", () => {
  assert.equal(isEcho("/tmp/aya-echo-test/never-written.json", "{}"), false);
});

test("a later write supersedes the recorded hash", () => {
  const p = "/tmp/aya-echo-test/presets.json";
  recordWrite(p, "v1");
  recordWrite(p, "v2");
  assert.equal(isEcho(p, "v1"), false); // old content now reads as external
  assert.equal(isEcho(p, "v2"), true);
});

test("hashes are keyed per path — same content, different files don't collide", () => {
  recordWrite("/tmp/aya-echo-test/a.json", "same");
  // b.json was never written, so identical content is NOT an echo for it.
  assert.equal(isEcho("/tmp/aya-echo-test/b.json", "same"), false);
});

test("hashConfig is stable and content-sensitive", () => {
  assert.equal(hashConfig("abc"), hashConfig("abc"));
  assert.notEqual(hashConfig("abc"), hashConfig("abd"));
});

// The in-memory cases above hand the SAME string to recordWrite and isEcho, so
// they never prove the bytes Aya writes equal the bytes the watcher reads back.
// These go through the real disk round-trip (writeFileAtomic -> read).

test("a real writeFileAtomic round-trip reads back as an echo", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-echo-"));
  try {
    const target = path.join(dir, "snippets.json");
    const data =
      JSON.stringify(
        { snippets: [{ id: "x", name: "n", text: "t", autoRun: false }] },
        null,
        2,
      ) + "\n";
    await writeFileAtomic(target, data); // records the hash internally
    assert.equal(isEcho(target, await readFile(target, "utf8")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an out-of-band edit after our write is not an echo", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-echo-"));
  try {
    const target = path.join(dir, "presets.json");
    await writeFileAtomic(target, '{"presets":[]}'); // our own save, recorded
    await writeFile(target, '{"presets":[{"id":"hand-edited"}]}'); // external edit
    assert.equal(isEcho(target, await readFile(target, "utf8")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
