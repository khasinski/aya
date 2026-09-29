// Claude registers each running CLI in <configDir>/sessions/<pid>.json; Aya
// reads the sessionId there so a restart resumes that pane's own conversation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, readClaudeSessionId, watchClaudeSession } from "../dist-electron/claude-session.js";

function configDir(sessions) {
  const dir = mkdtempSync(join(tmpdir(), "aya-claude-"));
  mkdirSync(join(dir, "sessions"));
  for (const [pid, body] of Object.entries(sessions)) {
    writeFileSync(join(dir, "sessions", `${pid}.json`), body);
  }
  return dir;
}

test("readClaudeSessionId returns the conversation that pid is in", async () => {
  const dir = configDir({
    101: JSON.stringify({ pid: 101, sessionId: "8c57e24a-75d4-41b9-85e7-6465b1cae474" }),
    202: JSON.stringify({ pid: 202, sessionId: "a37e123d-4752-436a-8c1a-595a45fbf5cf" }),
  });
  try {
    assert.equal(await readClaudeSessionId(dir, 101), "8c57e24a-75d4-41b9-85e7-6465b1cae474");
    assert.equal(await readClaudeSessionId(dir, 202), "a37e123d-4752-436a-8c1a-595a45fbf5cf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readClaudeSessionId: no file yet, bad JSON, or an id unsafe on a command line is null", async () => {
  const dir = configDir({
    1: "{not json",
    2: JSON.stringify({ sessionId: "abc; rm -rf ~" }),
    3: JSON.stringify({ sessionId: 42 }),
  });
  try {
    for (const pid of [1, 2, 3, 4]) assert.equal(await readClaudeSessionId(dir, pid), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeConfigDir: the preset's dir, else CLAUDE_CONFIG_DIR, else ~/.claude", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(claudeConfigDir("~/.claude_chris"), join(homedir(), ".claude_chris"));
    assert.equal(claudeConfigDir(undefined), join(homedir(), ".claude"));
    process.env.CLAUDE_CONFIG_DIR = "/opt/claude";
    assert.equal(claudeConfigDir(undefined), "/opt/claude");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("watchClaudeSession reports the id on every poll, so a window that missed one still gets it", async () => {
  const dir = configDir({ 7: JSON.stringify({ pid: 7, sessionId: "8c57e24a-75d4-41b9-85e7-6465b1cae474" }) });
  const seen = [];
  const stop = watchClaudeSession(dir, 7, (id) => seen.push(id), 10);
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(seen.length >= 2, `reported ${seen.length} time(s)`);
  assert.ok(seen.every((id) => id === "8c57e24a-75d4-41b9-85e7-6465b1cae474"));
});

test("watchClaudeSession stays quiet once stopped", async () => {
  const dir = configDir({ 7: JSON.stringify({ pid: 7, sessionId: "8c57e24a-75d4-41b9-85e7-6465b1cae474" }) });
  const seen = [];
  const stop = watchClaudeSession(dir, 7, (id) => seen.push(id), 10);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(seen.length, 0);
});

test("watchClaudeSession with a cwd reports only a conversation Claude saved a transcript for", async () => {
  const id = "8c57e24a-75d4-41b9-85e7-6465b1cae474";
  const dir = configDir({ 7: JSON.stringify({ pid: 7, sessionId: id }) });
  const cwd = "/Users/dev/my proj";
  const seen = [];
  const stop = watchClaudeSession(dir, 7, (s) => seen.push(s), 10, cwd);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.length, 0, "no transcript yet: resuming it would exit at once");
    mkdirSync(join(dir, "projects", "-Users-dev-my-proj"), { recursive: true });
    writeFileSync(join(dir, "projects", "-Users-dev-my-proj", `${id}.jsonl`), "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(seen.length >= 1 && seen.every((s) => s === id));
});

test("a restore resuming a conversation Claude no longer has continues the latest instead", async () => {
  const { withLiveClaudeResume } = await import("../dist-electron/claude-session.js");
  const id = "8c57e24a-75d4-41b9-85e7-6465b1cae474";
  const dir = configDir({});
  try {
    assert.equal(await withLiveClaudeResume(`claude --resume ${id}`, dir, "/p"), "claude --continue");
    assert.equal(await withLiveClaudeResume(`claude --model opus --resume=${id}`, dir, "/p"), "claude --model opus --continue");
    mkdirSync(join(dir, "projects", "-p"), { recursive: true });
    writeFileSync(join(dir, "projects", "-p", `${id}.jsonl`), "{}\n");
    assert.equal(await withLiveClaudeResume(`claude --resume ${id}`, dir, "/p"), `claude --resume ${id}`);
    assert.equal(await withLiveClaudeResume("claude --continue", dir, "/p"), "claude --continue");
    assert.equal(await withLiveClaudeResume("claude", dir, "/p"), "claude");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
