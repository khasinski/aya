// Claude writes sessions/<pid>.json only after the trust screen; until then the file under its pid may be a dead
// claude's with the same pid. Only a file of a process started since the spawn is the pane's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSessionId, watchClaudeSession } from "../dist-electron/claude-session.js";

const OURS = "11111111-1111-4111-8111-111111111111";
const LEFTOVER = "22222222-2222-4222-8222-222222222222";
const SPAWNED_AT = 1_000_000;

/** The id read for a pane spawned at SPAWNED_AT (pid 9) while sessions/9.json holds `body`. */
async function readFor(body) {
  const dir = mkdtempSync(join(tmpdir(), "aya-claude-reuse-"));
  try {
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "9.json"), JSON.stringify({ pid: 9, cwd: "/pane", ...body }));
    return await readClaudeSessionId(dir, 9, SPAWNED_AT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// [label, file under the pane's pid, id read]
const ROWS = [
  ["a dead claude's leftover, started before the spawn (trust screen still up)", { sessionId: LEFTOVER, startedAt: SPAWNED_AT - 3_600_000 }, null],
  ["a leftover started a few seconds before the spawn", { sessionId: LEFTOVER, startedAt: SPAWNED_AT - 5_000 }, null],
  ["the new claude's own file", { sessionId: OURS, startedAt: SPAWNED_AT + 2_000 }, OURS],
  ["the new claude's file within the clock's slack", { sessionId: OURS, startedAt: SPAWNED_AT - 500 }, OURS],
  ["a file started a second before the spawn (the slack's edge)", { sessionId: OURS, startedAt: SPAWNED_AT - 1_000 }, OURS],
  ["a file started two seconds before the spawn", { sessionId: LEFTOVER, startedAt: SPAWNED_AT - 2_000 }, null],
  ["the new claude after /clear (same process, new conversation)", { sessionId: OURS, startedAt: SPAWNED_AT + 2_000, procStart: "x" }, OURS],
  ["a file with no start time (a claude that does not write one)", { sessionId: OURS }, OURS],
  ["a start time that is not a number", { sessionId: OURS, startedAt: "0" }, OURS],
];

for (const [label, body, id] of ROWS) {
  test(`claude session under a reused pid | ${label}`, async () => {
    assert.equal(await readFor(body), id);
  });
}

test("claude session under a reused pid | without a spawn time every file counts (callers that do not know it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-claude-reuse-"));
  try {
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "9.json"), JSON.stringify({ pid: 9, sessionId: LEFTOVER, startedAt: 1 }));
    const first = await new Promise((resolve) => {
      const stop = watchClaudeSession(dir, 9, (s) => (stop(), resolve(s)), 10);
    });
    assert.equal(first, LEFTOVER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
