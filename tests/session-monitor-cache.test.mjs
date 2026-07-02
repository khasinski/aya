// mtime-gated caching for cctop session files, isolated to a temp dir via the
// optional dir parameter (the real ~/.cctop is never read). The renderer polls
// every 5s, so unchanged files must reuse the cached parse. Proof of "no
// re-read": rewrite the CONTENT but restore the exact mtime — the old parse
// keeps coming back; only an mtime change surfaces the new state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aya-session-cache-test-"));

const T1 = 1_750_000_000;
const T2 = T1 + 10;

const sessionJson = (status) =>
  JSON.stringify({
    session_id: "s1",
    project_path: "/tmp/project",
    status,
    last_activity: "2026-06-03T11:00:00.000Z",
  });

const fileA = join(dir, "s1.json");
const fileB = join(dir, "s2.json");

const { listMonitoredSessions, resetSessionMonitorCache } = await import(
  "../dist-electron/session-monitor.js"
);

test("unchanged mtime returns the cached parse (content not re-read)", async () => {
  writeFileSync(fileA, sessionJson("working"));
  utimesSync(fileA, T1, T1);
  let out = await listMonitoredSessions(dir);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "active");

  // Rewrite to a waiting status but restore the mtime: the cached "active"
  // parse must come back, proving the file wasn't re-read.
  writeFileSync(fileA, sessionJson("waiting_permission"));
  utimesSync(fileA, T1, T1);
  out = await listMonitoredSessions(dir);
  assert.equal(out[0].level, "active");
});

test("an mtime change re-parses the file", async () => {
  utimesSync(fileA, T2, T2);
  const out = await listMonitoredSessions(dir);
  assert.equal(out[0].level, "waiting");
});

test("a new session file is picked up within one poll", async () => {
  writeFileSync(fileB, JSON.stringify({
    session_id: "s2",
    project_path: "/tmp/other",
    status: "working",
    last_activity: "2026-06-04T11:00:00.000Z",
  }));
  utimesSync(fileB, T2, T2);
  const out = await listMonitoredSessions(dir);
  assert.equal(out.length, 2);
});

test("a deleted session file drops out (and its cache entry with it)", async () => {
  rmSync(fileB);
  assert.equal((await listMonitoredSessions(dir)).length, 1);
  // Recreate with the SAME path and mtime as before but different content: a
  // stale cache entry would return the old session id.
  writeFileSync(fileB, JSON.stringify({
    session_id: "s2-reborn",
    project_path: "/tmp/other",
    status: "working",
    last_activity: "2026-06-04T11:00:00.000Z",
  }));
  utimesSync(fileB, T2, T2);
  const out = await listMonitoredSessions(dir);
  assert.equal(out.length, 2);
  assert.ok(out.some((s) => s.id === "s2-reborn"));
});

test("resetSessionMonitorCache forces a re-parse", async () => {
  writeFileSync(fileA, sessionJson("idle"));
  utimesSync(fileA, T2, T2); // restored mtime — cached without a reset
  resetSessionMonitorCache();
  const out = await listMonitoredSessions(dir);
  assert.equal(out.find((s) => s.id === "s1").level, "done");
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
