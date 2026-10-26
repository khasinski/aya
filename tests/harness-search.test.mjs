// Harness-aware search: transcript extraction (Claude + Codex JSONL), token
// matching/snippets, and end-to-end session discovery against temp fixture
// dirs (the real ~/.claude / ~/.codex are never read — every search passes an
// explicit configDir override).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, rmSync, writeSync, writeFileSync, utimesSync } from "node:fs";
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
  assert.equal(hits.hits.length, 2);
  assert.equal(hits.hits[0].sessionId, "new-session");
  assert.equal(hits.hits[0].role, "assistant");
  assert.equal(hits.hits[1].sessionId, "old-session");

  // AND semantics across the same message.
  const anded = await searchHarnessSessions({
    agent: "claude",
    cwd: CWD,
    configDir: root,
    query: "certificate expired",
  });
  assert.equal(anded.hits.length, 1);
  assert.equal(anded.hits[0].sessionId, "new-session");

  // Unknown cwd → no hits, no error.
  const none = await searchHarnessSessions({
    agent: "claude",
    cwd: "/somewhere/else",
    configDir: root,
    query: "signing",
  });
  assert.deepEqual(none.hits, []);
});

test("searchHarnessSessions returns matching messages newest-first within one session", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-message-order-"));
  const t = Math.floor(Date.now() / 1000);
  writeClaudeSession(root, "one-session", [
    claudeLine({ type: "user", timestamp: "2026-07-01T09:00:00.000Z", message: { role: "user", content: "needle oldest" } }),
    claudeLine({ type: "assistant", timestamp: "2026-07-01T09:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "needle middle" }] } }),
    claudeLine({ type: "user", timestamp: "2026-07-01T09:02:00.000Z", message: { role: "user", content: "needle newest" } }),
  ], t);
  try {
    const hits = await searchHarnessSessions({
      agent: "claude",
      cwd: CWD,
      configDir: root,
      query: "needle",
    });
    assert.deepEqual(hits.hits.map((hit) => hit.text), ["needle newest", "needle middle", "needle oldest"]);
  } finally {
    resetHarnessSearchCaches();
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal((await searchHarnessSessions(req)).hits.length, 0);

  const appended =
    claudeLine({
      type: "user",
      message: { role: "user", content: "second prompt" },
    }) + "\n";
  writeFileSync(file, appended, { flag: "a" });
  utimesSync(file, t, t);
  assert.equal((await searchHarnessSessions(req)).hits.length, 1);
});

test("history search skips a message over 64 KiB, keeps older hits, and discloses partial coverage", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-message-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oversized = claudeMessage("oversized " + "x".repeat(70 * 1024), "2026-10-26T09:30:00.000Z");
  writeClaudeSession(root, "message-cap", [
    claudeMessage("older target", "2026-10-26T09:00:00.000Z"),
    oversized,
    claudeMessage("newer target", "2026-10-26T10:00:00.000Z"),
  ], Math.floor(Date.now() / 1000));
  let maxCarry = 0;
  const result = await searchHarnessSessions({
    agent: "claude",
    cwd: CWD,
    configDir: root,
    query: "target",
  }, { onMaxCarryBytes: (bytes) => { maxCarry = Math.max(maxCarry, bytes); } });
  assert.deepEqual(result.hits.map((hit) => hit.text), ["newer target", "older target"]);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.searchedBackTo, "2026-10-26T09:00:00.000Z");
  assert.ok(maxCarry <= 64 * 1024, `scanner retained ${maxCarry} bytes in a line carry`);
});

test("an empty result discloses that very long messages were skipped", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-long-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeClaudeSession(root, "long-only", [
    claudeMessage("needle " + "x".repeat(70 * 1024), "2026-10-26T09:30:00.000Z"),
  ], Math.floor(Date.now() / 1000));
  const result = await searchHarnessSessions({
    agent: "claude", cwd: CWD, configDir: root, query: "needle",
  });
  assert.deepEqual(result.hits, []);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.longMessagesSkipped, true);
});

test("oversized messages and non-message records are classified from a bounded prefix", async (t) => {
  const cases = [
    {
      agent: "claude",
      id: "claude-message",
      oversizedLine: claudeMessage(`needle ${"x".repeat(70 * 1024)}`),
      expectNotice: true,
    },
    {
      agent: "claude",
      id: "claude-progress",
      oversizedLine: claudeLine({ type: "progress", data: "x".repeat(70 * 1024) }),
      expectNotice: false,
    },
    {
      agent: "codex",
      id: "codex-message",
      oversizedLine: codexMessage("assistant", `needle ${"x".repeat(70 * 1024)}`),
      expectNotice: true,
    },
    {
      agent: "codex",
      id: "codex-event",
      oversizedLine: codexLine({ type: "event_msg", payload: { type: "token_count", data: "x".repeat(70 * 1024) } }),
      expectNotice: false,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.id, async (t) => {
      const root = mkdtempSync(join(tmpdir(), `aya-hsearch-${scenario.id}-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      if (scenario.agent === "claude") {
        writeClaudeSession(root, scenario.id, [scenario.oversizedLine], Math.floor(Date.now() / 1000));
      } else {
        const day = join(root, "sessions", "2026", "10", "26");
        mkdirSync(day, { recursive: true });
        writeFileSync(join(day, `rollout-${scenario.id}.jsonl`), `${codexLine({ type: "session_meta", payload: { cwd: CWD } })}\n${scenario.oversizedLine}\n`);
      }
      const result = await searchHarnessSessions({
        agent: scenario.agent,
        cwd: CWD,
        configDir: root,
        query: "needle",
      });
      assert.equal(result.coverage.partial, true);
      assert.equal(result.coverage.longMessagesSkipped, scenario.expectNotice ? true : undefined);
    });
  }
});

test("cached history marks results partial when the cached hit cap is reached", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-cached-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Math.floor(Date.now() / 1000);
  for (let session = 0; session < 5; session++) {
    const lines = Array.from({ length: 21 }, (_, i) =>
      claudeMessage(`quota hit ${session}-${i}`, `2026-10-26T09:${String(i).padStart(2, "0")}:00.000Z`),
    );
    writeClaudeSession(root, `cached-${session}`, lines, now - session);
  }
  const req = { agent: "claude", cwd: CWD, configDir: root, query: "prime-cache-never-matches" };
  assert.equal((await searchHarnessSessions(req)).hits.length, 0);
  const result = await searchHarnessSessions({ ...req, query: "quota hit" });
  assert.equal(result.hits.length, 80);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.hitLimitReached, 80);
});

test("deadline is checked while walking cached messages", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-cached-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeClaudeSession(root, "cached", [
    claudeMessage("needle oldest", "2026-10-26T09:00:00.000Z"),
    claudeMessage("needle middle", "2026-10-26T09:01:00.000Z"),
    claudeMessage("needle newest", "2026-10-26T09:02:00.000Z"),
  ], Math.floor(Date.now() / 1000));
  const request = { agent: "claude", cwd: CWD, configDir: root, query: "not-present" };
  await searchHarnessSessions(request); // populate the small-transcript cache

  let calls = 0;
  const result = await searchHarnessSessions({ ...request, query: "needle" }, {
    timeBudgetMs: 1,
    now: () => (++calls >= 8 ? 2 : 0),
  });
  assert.deepEqual(result.hits.map((hit) => hit.text), ["needle newest"]);
  assert.equal(result.coverage.partial, true);
});

test("deadline during session discovery reports no searched boundary", async (t) => {
  for (const agent of ["claude", "codex"]) {
    await t.test(agent, async (t) => {
      const root = mkdtempSync(join(tmpdir(), `aya-hsearch-discovery-${agent}-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const nowSec = Math.floor(Date.now() / 1000);
      if (agent === "claude") {
        writeClaudeSession(root, "not-read", [claudeMessage("needle", "2026-10-26T09:00:00.000Z")], nowSec);
      } else {
        const dir = join(root, "sessions", "2026", "10", "26");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "rollout-not-read.jsonl"), `${codexLine({ type: "session_meta", payload: { cwd: CWD } })}\n${codexMessage("assistant", "needle")}\n`);
      }
      let calls = 0;
      const result = await searchHarnessSessions({
        agent,
        cwd: CWD,
        configDir: root,
        query: "needle",
      }, {
        timeBudgetMs: 5,
        now: () => ++calls >= 4 ? 10 : 0,
      });
      assert.deepEqual(result.hits, []);
      assert.equal(result.coverage.partial, true);
      assert.equal(result.coverage.searchedBackTo, undefined);
    });
  }
});

test("partial discovery never claims a searched boundary from its incomplete file list", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-discovery-partial-date-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeClaudeSession(root, "one-found", [
    claudeMessage("needle found", "2026-10-26T09:00:00.000Z"),
  ], Math.floor(Date.now() / 1000));
  let calls = 0;
  const clockValues = [0, 0, 0, 10, 0, 0, 0, 0, 0];
  const result = await searchHarnessSessions({
    agent: "claude", cwd: CWD, configDir: root, query: "needle",
  }, {
    timeBudgetMs: 5,
    now: () => clockValues[calls++] ?? 0,
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.searchedBackTo, undefined);
});

test("a superseded history search stops scanning after its signal is aborted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-hsearch-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "projects", claudeProjectDirName(CWD));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "large.jsonl");
  const line = `${JSON.stringify({ type: "progress", padding: "x".repeat(700) })}\n`;
  writeFileSync(file, line.repeat(2000));
  const controller = new AbortController();
  let carryChecks = 0;
  let bytesRead = 0;
  const result = await searchHarnessSessions({
    agent: "claude", cwd: CWD, configDir: root, query: "needle",
  }, {
    signal: controller.signal,
    chunkBytes: 1024,
    onMaxCarryBytes: () => {
      if (++carryChecks === 1) controller.abort();
    },
    onBytesRead: (bytes) => { bytesRead = bytes; },
  });
  assert.ok(carryChecks >= 1);
  assert.equal(result.coverage.partial, true);
  assert.ok(result.coverage.searchedBackTo);
  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(file)).size > 1_000_000);
  assert.ok(bytesRead < 10_000, `superseded scan read ${bytesRead} bytes`);
});

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
  assert.equal(hits.hits.length, 1);
  assert.equal(hits.hits[0].sessionId, "2026-07-01T10-00-00-abc");
  assert.equal(hits.hits[0].role, "assistant");
  assert.ok(hits.hits[0].snippet.includes("worker.ts"));
});

function claudeMessage(text, timestamp) {
  return claudeLine({
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function fakeClock(hitBudget) {
  let calls = 0;
  return () => {
    calls += 1;
    return hitBudget && calls >= 8 ? 10 : 0;
  };
}

test("full-history scan coverage is honest and memory stays bounded", async (t) => {
  const cases = [];
  for (const size of ["small", "over-8MiB", "sparse-1GiB"]) {
    for (const position of ["newest", "oldest", "none"]) {
      for (const budgetHit of [false, true]) {
        cases.push({ size, position, budgetHit });
      }
    }
  }
  for (const { size, position, budgetHit } of cases) {
    await t.test(`${size}, ${position} match, budget ${budgetHit ? "hit" : "not hit"}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "aya-hsearch-full-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const dir = join(root, "projects", claudeProjectDirName(CWD));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "session.jsonl");
      const oldest = claudeMessage("oldest coverage needle", "2026-10-26T09:00:00.000Z");
      const newest = claudeMessage("newest coverage needle", "2026-10-26T10:00:00.000Z");
      const noise = `${JSON.stringify({ type: "progress", padding: "x".repeat(60 * 1024) })}\n`;
      const nowSec = Math.floor(Date.now() / 1000);
      let chunkBytes = 1024;
      if (size === "small") {
        writeFileSync(file, `${oldest}\n${noise.repeat(3)}${newest}\n`);
      } else if (size === "over-8MiB") {
        writeFileSync(file, `${oldest}\n${noise.repeat(145)}${newest}\n`);
      } else {
        const fd = openSync(file, "w+");
        const fileBytes = 1024 * 1024 * 1024;
        const prefix = Buffer.from(`${oldest}\n`);
        const suffix = Buffer.from(`\n${newest}\n`);
        try {
          ftruncateSync(fd, fileBytes);
          writeSync(fd, prefix, 0, prefix.length, 0);
          writeSync(fd, suffix, 0, suffix.length, fileBytes - suffix.length);
        } finally {
          closeSync(fd);
        }
        chunkBytes = 4 * 1024 * 1024;
      }
      utimesSync(file, nowSec, nowSec);
      resetHarnessSearchCaches();
      let maxCarry = 0;
      const before = process.memoryUsage().rss;
      const result = await searchHarnessSessions({
        agent: "claude",
        cwd: CWD,
        configDir: root,
        query: size === "over-8MiB" && position === "newest" && !budgetHit
          ? "coverage"
          : position === "newest"
            ? "newest coverage"
            : position === "oldest"
              ? "oldest coverage"
              : "absent term",
      }, {
        timeBudgetMs: budgetHit ? 5 : 30_000,
        now: fakeClock(budgetHit),
        chunkBytes,
        onMaxCarryBytes: (bytes) => { maxCarry = Math.max(maxCarry, bytes); },
      });
      const after = process.memoryUsage().rss;
      const shouldFind = position !== "none" && !(budgetHit && position === "oldest");
      assert.equal(result.hits.length > 0, shouldFind);
      if (shouldFind) {
        assert.match(result.hits[0].text, position === "newest" ? /newest coverage/ : /oldest coverage/);
      }
      if (size === "over-8MiB" && !budgetHit && position === "newest") {
        assert.deepEqual(result.hits.map((hit) => hit.text.match(/(?:newest|oldest) coverage/)?.[0]), [
          "newest coverage",
          "oldest coverage",
        ]);
      }
      assert.equal(result.coverage.partial, budgetHit || size === "sparse-1GiB");
      if (result.coverage.partial) assert.ok(result.coverage.searchedBackTo);
      assert.ok(maxCarry <= 64 * 1024, `scanner retained ${maxCarry} bytes in a line carry`);
      assert.ok(after - before < 128 * 1024 * 1024, `RSS grew by ${after - before} bytes`);
    });
  }
});
