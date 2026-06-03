// Crash-safe writes: every file in ~/.aya/ goes through writeFileAtomic so a
// crash mid-write can't leave a truncated JSON behind. The README sells this
// guarantee, so it should fail loudly if the contract regresses.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../dist-electron/atomic-write.js";
import { isEcho } from "../dist-electron/config-echo.js";

// Per-writer payload length (chars) in the concurrent-write race test.
const RACE_TEST_PAYLOAD_SIZE = 2000;
// Large-payload stress size (bytes) for the atomic-write durability test.
const ATOMIC_WRITE_LARGE_PAYLOAD_BYTES = 200000;

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), "aya-atomic-"));
}

test("writes the target file with the given contents", async () => {
  const dir = await makeTmpDir();
  try {
    const target = path.join(dir, "config.json");
    await writeFileAtomic(target, '{"hello":"world"}');
    const contents = await readFile(target, "utf8");
    assert.equal(contents, '{"hello":"world"}');
    // A successful write must record the hash so the config watcher can tell
    // this save apart from an edit made outside the app (see config-echo.ts).
    assert.equal(isEcho(target, '{"hello":"world"}'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creates the parent directory if it doesn't exist yet", async () => {
  const dir = await makeTmpDir();
  try {
    const target = path.join(dir, "deeply", "nested", "presets.json");
    await writeFileAtomic(target, "[]");
    const contents = await readFile(target, "utf8");
    assert.equal(contents, "[]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("overwrites an existing file atomically (no leftover .tmp)", async () => {
  const dir = await makeTmpDir();
  try {
    const target = path.join(dir, "themes.json");
    await writeFile(target, '{"old":true}');
    await writeFileAtomic(target, '{"new":true}');
    const contents = await readFile(target, "utf8");
    assert.equal(contents, '{"new":true}');
    const remaining = await readdir(dir);
    assert.deepEqual(
      remaining,
      ["themes.json"],
      `expected only the target file, got: ${remaining.join(", ")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleans up the .tmp file when rename fails", async () => {
  const dir = await makeTmpDir();
  try {
    // Create a directory at the target path. Renaming a file over a non-empty
    // directory fails on every platform, which exercises the catch path.
    const target = path.join(dir, "blocked-by-dir");
    await rm(target, { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(target);
    await writeFile(path.join(target, "child"), "occupant");
    await assert.rejects(() => writeFileAtomic(target, "data"));
    // Nothing .tmp left around.
    const leaked = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leaked, [], `tmp file leaked: ${leaked.join(", ")}`);
    // A failed write records nothing: recordWrite runs only after the rename
    // succeeds, so the watcher would treat a later edit here as an outside one.
    assert.equal(isEcho(target, "data"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent writes to the same path don't truncate the result", async () => {
  // Two callers racing on the same path is rare (single-instance lock), but
  // the tmp-name suffix is randomized so even if it happens neither write
  // should clobber the other's tmp file. Final contents are one of the two
  // payloads, never a merge or empty file.
  const dir = await makeTmpDir();
  try {
    const target = path.join(dir, "race.json");
    const A =
      '{"writer":"A","payload":"' + "A".repeat(RACE_TEST_PAYLOAD_SIZE) + '"}';
    const B =
      '{"writer":"B","payload":"' + "B".repeat(RACE_TEST_PAYLOAD_SIZE) + '"}';
    await Promise.all([writeFileAtomic(target, A), writeFileAtomic(target, B)]);
    const contents = await readFile(target, "utf8");
    assert.ok(
      contents === A || contents === B,
      `expected one writer's payload, got ${contents.length} bytes`,
    );
    const leaked = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leaked, [], `tmp file leaked: ${leaked.join(", ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("survives writing a large payload (~200KB)", async () => {
  const dir = await makeTmpDir();
  try {
    const target = path.join(dir, "big.json");
    const big = '"' + "x".repeat(ATOMIC_WRITE_LARGE_PAYLOAD_BYTES) + '"';
    await writeFileAtomic(target, big);
    const stats = await stat(target);
    // The +2 accounts for the surrounding quotes.
    assert.equal(stats.size, ATOMIC_WRITE_LARGE_PAYLOAD_BYTES + 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes an empty string without leaving the file missing", async () => {
  const dir = await makeTmpDir();
  try {
    const target = path.join(dir, "empty");
    await writeFileAtomic(target, "");
    const contents = await readFile(target, "utf8");
    assert.equal(contents, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
