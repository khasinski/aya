// Metadata-gated cctop reads, isolated from the real ~/.cctop. Cache reuse
// must avoid I/O while noticing atomic replacements with preserved mtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync, renameSync, promises as fs } from "node:fs";
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

test("unchanged metadata returns the cached parse without opening the file", async t => {
  writeFileSync(fileA, sessionJson("working")); utimesSync(fileA, T1, T1);
  assert.equal((await listMonitoredSessions(dir))[0].level, "active");
  const opening = t.mock.method(fs, 'open');
  assert.equal((await listMonitoredSessions(dir))[0].level, "active");
  assert.equal(opening.mock.callCount(), 0);
});

test("atomic replacement with the same size and mtime refreshes the session", async () => {
  const replacement = fileA + '.replacement';
  writeFileSync(replacement, sessionJson("idle   ")); utimesSync(replacement, T1, T1);
  renameSync(replacement, fileA);
  assert.equal((await listMonitoredSessions(dir))[0].level, 'done');
  writeFileSync(fileA, sessionJson('waiting_permission')); utimesSync(fileA, T1, T1);
  assert.equal((await listMonitoredSessions(dir))[0].level, 'waiting');
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


test('oversized session files are skipped before opening their contents', async t => {
  const { MAX_SESSION_FILE_BYTES } = await import('../dist-electron/session-monitor.js');
  const own = mkdtempSync(join(tmpdir(), 'aya-session-bound-')); t.after(() => rmSync(own, { recursive: true, force: true }));
  writeFileSync(join(own, 'huge.json'), 'x'.repeat(MAX_SESSION_FILE_BYTES + 1));
  const opening = t.mock.method(fs, 'open');
  assert.deepEqual(await listMonitoredSessions(own), []);
  assert.equal(opening.mock.callCount(), 0);
});
