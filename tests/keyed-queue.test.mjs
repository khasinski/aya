// oneAtATime's bookkeeping only shows with a third caller that arrives once the first settled while the second still
// runs: it must wait for the second. Consumers' tests run only two callers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { oneAtATime, withFileLock, STALE_LOCK_MS, LOCK_RETRY_MIN_MS, LOCK_RETRY_JITTER_MS } = await import("../dist-electron/keyed-queue.js");
const { ownStartTime } = await import("../dist-electron/pty-host-registry.js");
// A pid in a lock is the writer only while that pid's OS start time is the one recorded next to it.
const OTHER_START = "Thu Jan  1 00:00:00 1970";

function latch() {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { opened, open };
}

/** Work that records when it runs and finishes only when `go` opens. */
function tracked(log, name, go, fail = false) {
  return async () => {
    log.push(`${name} in`);
    await go.opened;
    log.push(`${name} out`);
    if (fail) throw new Error(`${name} failed`);
    return name;
  };
}

for (const failFirst of [false, true]) {
  test(`one at a time | a third call after the first ${failFirst ? "failed" : "settled"}, the second still running: it waits for the second`, async () => {
    const one = oneAtATime();
    const log = [];
    const [a, b, c] = [latch(), latch(), latch()];
    const first = one("k", tracked(log, "first", a, failFirst));
    const second = one("k", tracked(log, "second", b));
    a.open();
    await first.catch(() => {});
    while (!log.includes("second in")) await new Promise((resolve) => setImmediate(resolve));
    const third = one("k", tracked(log, "third", c));
    c.open();
    await new Promise((resolve) => setImmediate(resolve));
    b.open();
    assert.deepEqual(await Promise.all([second, third]), ["second", "third"]);
    assert.deepEqual(log, ["first in", "first out", "second in", "second out", "third in", "third out"]);
  });
}

test("one at a time | different keys do not wait for each other", async () => {
  const one = oneAtATime();
  const log = [];
  const [a, b] = [latch(), latch()];
  const first = one("a", tracked(log, "a", a));
  const second = one("b", tracked(log, "b", b));
  b.open();
  assert.equal(await second, "b");
  assert.deepEqual(log, ["a in", "b in", "b out"]);
  a.open();
  await first;
});

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withinTwoSeconds = (p) => Promise.race([p, tick(2000).then(() => assert.fail("the lock was never taken"))]);

for (const [name, content, ageMs] of [
  ["a dead process's", () => String(spawnSync(process.execPath, ["-e", ""]).pid), 0],
  ["a live process's, older than 10 s", () => String(process.pid), STALE_LOCK_MS + 2_000],
  ["a reused pid's (live, another start time)", () => `${process.pid} ${OTHER_START}`, 0],
  ["a dead process's with its start time", () => `${spawnSync(process.execPath, ["-e", ""]).pid} ${OTHER_START}`, 0],
]) {
  test(`file lock | ${name} lock is taken over; the lock is gone after the work`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "aya-lock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lock = join(dir, "x.lock");
    writeFileSync(lock, content());
    const then = (Date.now() - ageMs) / 1000;
    utimesSync(lock, then, then);
    assert.equal(await withinTwoSeconds(withFileLock(lock, async () => "ran")), "ran");
    assert.equal(existsSync(lock), false);
  });
}

test("file lock | the lock names this process by pid and OS start time", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, "x.lock");
  const { readFileSync } = await import("node:fs");
  const held = await withFileLock(lock, async () => readFileSync(lock, "utf8"));
  assert.equal(held, `${process.pid} ${ownStartTime()}`);
  assert.match(held, /^\d+ \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
});

test("file lock | a lock is stale after 10 s; a held one is tried again every 5 to 25 ms", () => {
  assert.deepEqual([STALE_LOCK_MS, LOCK_RETRY_MIN_MS, LOCK_RETRY_JITTER_MS], [10_000, 5, 20]);
});

for (const [name, content, ageMs] of [
  ["a live process's", () => String(process.pid), 0],
  ["a live process's with its own start time", () => `${process.pid} ${ownStartTime()}`, 0],
  ["one written but its pid not yet", () => "", 0],
  ["a live process's, 2 s short of stale,", () => String(process.pid), STALE_LOCK_MS - 2_000],
]) {
  test(`file lock | ${name} fresh lock is waited for until it goes`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "aya-lock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lock = join(dir, "x.lock");
    writeFileSync(lock, content());
    const then = (Date.now() - ageMs) / 1000;
    utimesSync(lock, then, then);
    let ran = false;
    const work = withFileLock(lock, async () => (ran = true));
    await tick(150);
    assert.equal(ran, false);
    rmSync(lock);
    await withinTwoSeconds(work);
    assert.equal(ran, true);
  });
}

test("file lock | a lock that cannot be made (a read-only dir): the work runs and fails as it would", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-lock-"));
  chmodSync(dir, 0o500);
  t.after(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await withinTwoSeconds(withFileLock(join(dir, "x.lock"), async () => "ran")), "ran");
});

test("file lock | a lock whose dir is a file: the work runs and fails as it would, not waits for ever", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "settings"), "");
  assert.equal(await withinTwoSeconds(withFileLock(join(dir, "settings", "x.lock"), async () => "ran")), "ran");
});

test("file lock | a lock in a dir not made yet is taken, not skipped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, "new", "x.lock");
  assert.equal(await withFileLock(lock, async () => existsSync(lock)), true);
  assert.equal(existsSync(lock), false);
});
