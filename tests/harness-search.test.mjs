// Harness-aware search: transcript extraction (Claude + Codex JSONL), token
// matching/snippets, and end-to-end session discovery against temp fixture
// dirs (the real ~/.claude / ~/.codex are never read — every search passes an
// explicit configDir override).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  claudeProjectDirName,
  extractClaudeMessages,
  extractCodexMessages,
  matchMessage,
  searchHarnessSessions,
  resetHarnessSearchCaches,
} = await import("../dist-electron/harness-search.js");

beforeEach(() => resetHarnessSearchCaches());

// ---- Claude extraction -------------------------------------------------------

const claudeLine = (obj) => JSON.stringify(obj);

test("claudeProjectDirName mirrors Claude Code's cwd slugging", () => {
  assert.equal(
    claudeProjectDirName("/Users/x/Projects/aya"),
    "-Users-x-Projects-aya",
  );
  assert.equal(claudeProjectDirName("/tmp/my.app_v2"), "-tmp-my-app-v2");
});

test("extractClaudeMessages keeps real prose, drops noise", () => {
  const lines = [
    claudeLine({
      type: "user",
      timestamp: "2026-07-01T10:00:00.000Z",
      message: { role: "user", content: "fix the login bug" },
    }),
    claudeLine({
      type: "assistant",
      timestamp: "2026-07-01T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Looking at auth.ts now." },
          { type: "tool_use", name: "Read", input: { file: "auth.ts" } },
        ],
      },
    }),
    // Tool results come back as "user" messages with no text blocks.
    claudeLine({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "1\tsecret buffer dump" }],
      },
    }),
    // Injected wrappers no human typed.
    claudeLine({
      type: "user",
      message: { role: "user", content: "<command-name>/clear</command-name>" },
    }),
    claudeLine({
      type: "user",
      message: { role: "user", content: "Caveat: the messages below…" },
    }),
    // Subagent sidechain.
    claudeLine({
      type: "user",
      isSidechain: true,
      message: { role: "user", content: "sidechain prompt" },
    }),
    // Non-message bookkeeping + garbage survive silently.
    claudeLine({ type: "file-history-snapshot", snapshot: {} }),
    "{not json",
  ];
  const messages = extractClaudeMessages(lines);
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ["user", "fix the login bug"],
      ["assistant", "Looking at auth.ts now."],
    ],
  );
  assert.equal(messages[0].timestamp, "2026-07-01T10:00:00.000Z");
});

// ---- Codex extraction --------------------------------------------------------

const codexLine = (obj) => JSON.stringify(obj);
const codexMessage = (role, text, timestamp = "2026-07-01T10:00:00.000Z") =>
  codexLine({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [
        { type: role === "user" ? "input_text" : "output_text", text },
      ],
    },
  });

test("extractCodexMessages keeps user/assistant prose, drops the rest", () => {
  const lines = [
    codexLine({ type: "session_meta", payload: { cwd: "/p" } }),
    codexMessage("user", "why does the build fail?"),
    codexMessage("assistant", "The tsconfig excludes src."),
    codexMessage("developer", "<permissions instructions>…"),
    codexMessage("user", "<environment_context>…</environment_context>"),
    codexMessage("user", "# AGENTS.md instructions for /p"),
    codexLine({
      type: "response_item",
      payload: { type: "function_call", name: "shell" },
    }),
    codexLine({ type: "event_msg", payload: { type: "token_count" } }),
  ];
  assert.deepEqual(
    extractCodexMessages(lines).map((m) => [m.role, m.text]),
    [
      ["user", "why does the build fail?"],
      ["assistant", "The tsconfig excludes src."],
    ],
  );
});

// ---- Matching ----------------------------------------------------------------

const asMessage = (text) => ({
  role: "user",
  text,
  lower: text.toLowerCase(),
});

test("matchMessage ANDs tokens case-insensitively", () => {
  const m = asMessage("Permission DENIED while writing settings.json");
  assert.ok(matchMessage(m, ["denied", "permission"]));
  assert.equal(matchMessage(m, ["denied", "granted"]), null);
});

test("matchMessage snippet offsets point at the earliest token", () => {
  const long = "x".repeat(200) + " release Packaging step " + "y".repeat(200);
  const m = asMessage(long);
  const hit = matchMessage(m, ["packaging", "release"]);
  assert.ok(hit);
  // Earliest token is "release"; offsets must be valid within the snippet.
  assert.equal(
    hit.snippet
      .slice(hit.matchStart, hit.matchStart + hit.matchLength)
      .toLowerCase(),
    "release",
  );
  assert.ok(hit.snippet.startsWith("…"));
  assert.ok(hit.snippet.endsWith("…"));
  // Newlines/tabs are flattened without shifting offsets.
  const multiline = asMessage("first\nline permission\tdenied here");
  const h2 = matchMessage(multiline, ["permission"]);
  assert.ok(!h2.snippet.includes("\n"));
  assert.equal(
    h2.snippet.slice(h2.matchStart, h2.matchStart + h2.matchLength),
    "permission",
  );
});

// ---- End-to-end: Claude ------------------------------------------------------

const CWD = "/Users/test/proj";

function writeClaudeSession(root, name, lines, mtimeSec) {
  const dir = join(root, "projects", claudeProjectDirName(CWD));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

test("searchHarnessSessions finds Claude history for the cwd, newest session first", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-claude-"));
  const t = Math.floor(Date.now() / 1000);
  writeClaudeSession(
    root,
    "old-session",
    [
      claudeLine({
        type: "user",
        timestamp: "2026-07-01T09:00:00.000Z",
        message: { role: "user", content: "older signing problem" },
      }),
    ],
    t - 1000,
  );
  writeClaudeSession(
    root,
    "new-session",
    [
      claudeLine({
        type: "assistant",
        timestamp: "2026-07-02T09:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the signing certificate expired" }],
        },
      }),
    ],
    t,
  );

  const hits = await searchHarnessSessions({
    agent: "claude",
    cwd: CWD,
    configDir: root,
    query: "signing",
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].sessionId, "new-session");
  assert.equal(hits[0].role, "assistant");
  assert.equal(hits[1].sessionId, "old-session");

  // AND semantics across the same message.
  const anded = await searchHarnessSessions({
    agent: "claude",
    cwd: CWD,
    configDir: root,
    query: "certificate expired",
  });
  assert.equal(anded.length, 1);
  assert.equal(anded[0].sessionId, "new-session");

  // Unknown cwd → no hits, no error.
  const none = await searchHarnessSessions({
    agent: "claude",
    cwd: "/somewhere/else",
    configDir: root,
    query: "signing",
  });
  assert.deepEqual(none, []);
});

test("searchHarnessSessions notices appended Claude transcript lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-claude2-"));
  const t = Math.floor(Date.now() / 1000);
  const file = writeClaudeSession(
    root,
    "live",
    [
      claudeLine({
        type: "user",
        message: { role: "user", content: "first prompt" },
      }),
    ],
    t - 10,
  );
  const req = { agent: "claude", cwd: CWD, configDir: root, query: "second" };
  assert.equal((await searchHarnessSessions(req)).length, 0);

  const appended =
    claudeLine({
      type: "user",
      message: { role: "user", content: "second prompt" },
    }) + "\n";
  writeFileSync(file, appended, { flag: "a" });
  utimesSync(file, t, t);
  assert.equal((await searchHarnessSessions(req)).length, 1);
});

// ---- End-to-end: Codex -------------------------------------------------------

test("searchHarnessSessions filters Codex rollouts by session_meta cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-codex-"));
  const day = join(root, "sessions", "2026", "07", "01");
  mkdirSync(day, { recursive: true });
  const t = Math.floor(Date.now() / 1000);

  const mine = join(day, "rollout-2026-07-01T10-00-00-abc.jsonl");
  writeFileSync(
    mine,
    [
      codexLine({ type: "session_meta", payload: { id: "abc", cwd: CWD } }),
      codexMessage("assistant", "the flaky test is in worker.ts"),
    ].join("\n") + "\n",
  );
  utimesSync(mine, t, t);

  const other = join(day, "rollout-2026-07-01T11-00-00-def.jsonl");
  writeFileSync(
    other,
    [
      codexLine({
        type: "session_meta",
        payload: { id: "def", cwd: "/other/project" },
      }),
      codexMessage("assistant", "flaky test elsewhere"),
    ].join("\n") + "\n",
  );
  utimesSync(other, t, t);

  const hits = await searchHarnessSessions({
    agent: "codex",
    cwd: CWD,
    configDir: root,
    query: "flaky test",
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "2026-07-01T10-00-00-abc");
  assert.equal(hits[0].role, "assistant");
  assert.ok(hits[0].snippet.includes("worker.ts"));
});
