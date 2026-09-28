// Every Codex reader honors CODEX_HOME, not a hardcoded ~/.codex. HOME and
// CODEX_HOME are temp dirs set BEFORE import (load-time resolution); Node runs
// each test file in its own process, so the real home is never read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = mkdtempSync(join(tmpdir(), "aya-home-"));
const codexHome = mkdtempSync(join(tmpdir(), "aya-codex-home-"));
process.env.HOME = fakeHome;
process.env.CODEX_HOME = codexHome;

const { searchHarnessSessions } = await import("../dist-electron/harness-search.js");
const { codexUsageSources } = await import("../dist-electron/usage-codex.js");

function writeSession(home, text) {
  const day = join(home, "sessions", "2026", "07", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-07-01T10-00-00-abc.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "abc", cwd: "/p" } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      }),
    ].join("\n") + "\n",
  );
}

writeSession(codexHome, "found under codex home");
writeSession(join(fakeHome, ".codex"), "found under stock home");

test("history search without a configDir reads CODEX_HOME", async () => {
  const hits = await searchHarnessSessions({ agent: "codex", cwd: "/p", query: "found under" });
  assert.deepEqual(hits.map((h) => h.snippet.includes("codex home")), [true]);
});

test("history search with the stock ~/.codex configDir reads CODEX_HOME", async () => {
  const hits = await searchHarnessSessions({
    agent: "codex",
    cwd: "/p",
    configDir: "~/.codex",
    query: "found under",
  });
  assert.deepEqual(hits.map((h) => h.snippet.includes("codex home")), [true]);
});

test("usage sources: CODEX_HOME without presets and for a stock preset", () => {
  assert.deepEqual(codexUsageSources([]), [{ id: "codex", label: "Codex", home: codexHome }]);
  assert.deepEqual(
    codexUsageSources([
      { id: "a", name: "A", agent: "codex", command: "codex", configDir: "~/.codex" },
      { id: "b", name: "B", agent: "codex", command: "codex", configDir: "~/.codex-b" },
      { id: "c", name: "C", agent: "claude", command: "claude" },
    ]),
    [
      { id: "a", label: "A", home: codexHome },
      { id: "b", label: "B", home: join(fakeHome, ".codex-b") },
    ],
  );
});
