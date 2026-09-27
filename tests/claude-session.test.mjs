// Claude registers each running CLI in <configDir>/sessions/<pid>.json; Aya
// reads the sessionId there so a restart resumes that pane's own conversation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, readClaudeSessionId } from "../dist-electron/claude-session.js";

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
