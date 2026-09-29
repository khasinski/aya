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

function writeSession(home, text, cwd = "/p") {
  const day = join(home, "sessions", "2026", "07", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-07-01T10-00-00-abc.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "abc", cwd } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      }),
    ].join("\n") + "\n",
  );
}

writeSession(codexHome, "found under codex home");
const tabCwd = mkdtempSync(join(tmpdir(), "aya-tab-"));
const ayaCwd = mkdtempSync(join(tmpdir(), "aya-own-cwd-"));
process.chdir(ayaCwd);
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

test("history search resolves a relative configDir against the tab cwd", async () => {
  writeSession(join(tabCwd, ".rel"), "relative under tab", tabCwd);
  writeSession(join(ayaCwd, ".rel"), "relative under aya", tabCwd);
  const hits = await searchHarnessSessions({
    agent: "codex",
    cwd: tabCwd,
    configDir: ".rel",
    query: "relative under",
  });
  assert.deepEqual(hits.map((h) => h.snippet.includes("under tab")), [true]);
});

test("usage skips a relative CODEX_HOME: no tab cwd to resolve it against", () => {
  assert.deepEqual(
    codexUsageSources([
      { id: "r", name: "R", agent: "codex", command: "CODEX_HOME=.codex codex" },
      { id: "a", name: "A", agent: "codex", command: "codex" },
    ]),
    [{ id: "a", label: "A", home: codexHome }],
  );
});

test("history search with a relative configDir and no tab cwd finds nothing", async () => {
  assert.deepEqual(
    await searchHarnessSessions({ agent: "codex", cwd: "", configDir: ".rel", query: "relative under" }),
    [],
  );
});

test("history search follows an inline CODEX_HOME in the preset's command", async () => {
  const inline = mkdtempSync(join(tmpdir(), "aya-codex-inline-"));
  writeSession(inline, "inline home transcript");
  const hits = await searchHarnessSessions({
    agent: "codex",
    cwd: "/p",
    command: `CODEX_HOME=${inline} codex`,
    query: "inline home",
  });
  assert.deepEqual(hits.map((h) => h.snippet.includes("inline home")), [true]);
});
