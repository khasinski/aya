// Claude registers each running CLI in <configDir>/sessions/<pid>.json; Aya
// reads the sessionId there so a restart resumes that pane's own conversation.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, claudeTranscriptExists, readClaudeSessionId, shellClaudeConfigDir, watchClaudeSession, withLiveClaudeResume } from "../dist-electron/claude-session.js";

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

test("a restore resuming a conversation Claude no longer has starts a new one under the same id, not the latest", async () => {
  const { withLiveClaudeResume } = await import("../dist-electron/claude-session.js");
  const id = "8c57e24a-75d4-41b9-85e7-6465b1cae474";
  const dir = configDir({});
  try {
    assert.equal(await withLiveClaudeResume(`claude --resume ${id}`, dir, "/p"), `claude --session-id ${id}`);
    assert.equal(await withLiveClaudeResume(`claude --model opus --resume=${id}`, dir, "/p"), `claude --model opus --session-id ${id}`);
    mkdirSync(join(dir, "projects", "-p"), { recursive: true });
    writeFileSync(join(dir, "projects", "-p", `${id}.jsonl`), "{}\n");
    assert.equal(await withLiveClaudeResume(`claude --resume ${id}`, dir, "/p"), `claude --resume ${id}`);
    assert.equal(await withLiveClaudeResume("claude --continue", dir, "/p"), "claude --continue");
    assert.equal(await withLiveClaudeResume("claude", dir, "/p"), "claude");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ID = "8c57e24a-75d4-41b9-85e7-6465b1cae474";
const saveTranscript = (config, projectDirName) => {
  mkdirSync(join(config, "projects", projectDirName), { recursive: true });
  writeFileSync(join(config, "projects", projectDirName, `${ID}.jsonl`), "{}\n");
};

test("a transcript in a folder named the way claude names a long cwd (200 characters, then a hash) is found", async () => {
  const cwd = `/Users/dev/${"very-long-folder-".repeat(20)}proj`;
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  assert.ok(sanitized.length > 200);
  const config = configDir({});
  try {
    saveTranscript(config, `${sanitized.slice(0, 200)}-i5l7kn`);
    assert.equal(await claudeTranscriptExists(config, cwd, ID), true);
    assert.equal(await withLiveClaudeResume(`claude --resume ${ID}`, config, cwd), `claude --resume ${ID}`);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("a transcript under another folder's name is not proof the conversation is gone", async () => {
  const config = configDir({});
  try {
    saveTranscript(config, "-somewhere-else");
    assert.equal(await withLiveClaudeResume(`claude --resume ${ID}`, config, "/p"), `claude --resume ${ID}`);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("a transcript is found under the real folder of a symlinked cwd", async () => {
  const config = configDir({});
  const real = realpathSync(mkdtempSync(join(tmpdir(), "aya-claude-real-")));
  const link = join(mkdtempSync(join(tmpdir(), "aya-claude-link-")), "lnk");
  symlinkSync(real, link);
  try {
    saveTranscript(config, real.replace(/[^a-zA-Z0-9]/g, "-"));
    assert.equal(await claudeTranscriptExists(config, link, ID), true);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test("without a config dir of its own, the pane's shell says where claude keeps its conversations", async () => {
  const rc = configDir({});
  const command = `claude --resume ${ID}`;
  const gone = `claude --session-id ${ID}`;
  try {
    saveTranscript(rc, "-p");
    const home = mkdtempSync(join(tmpdir(), "aya-claude-home-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(await withLiveClaudeResume(command, undefined, "/p", async () => rc), command, "the rc dir has it");
      assert.equal(await withLiveClaudeResume(command, undefined, "/p", async () => ""), gone, "the shell sets none: gone");
      assert.equal(await withLiveClaudeResume(command, undefined, "/p", async () => join(home, "elsewhere")), gone, "the shell's dir lacks it: gone");
      assert.equal(await withLiveClaudeResume(command, undefined, "/p", async () => { throw new Error("no shell"); }), command, "shell unknown: keep");
      assert.equal(await withLiveClaudeResume(command, join(home, "explicit"), "/p", async () => rc), gone, "an explicit dir is not second-guessed");
    } finally {
      process.env.HOME = saved;
    }
  } finally {
    rmSync(rc, { recursive: true, force: true });
  }
});

// Each shell check has its own fixture; overlap them while preserving the real
// default 10-second timeout contract. None changes process.env.
describe("Claude config probes with independent shells", { concurrency: 3 }, () => {
  test("shellClaudeConfigDir reads CLAUDE_CONFIG_DIR as the pane's login shell sets it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aya-claude-shell-"));
    const shell = join(dir, "fakesh");
    writeFileSync(shell, '#!/bin/sh\necho "rc noise"\nexport CLAUDE_CONFIG_DIR=/from/rc\neval "$4"\n');
    chmodSync(shell, 0o755);
    const unset = join(dir, "unsetsh");
    writeFileSync(unset, '#!/bin/sh\nunset CLAUDE_CONFIG_DIR\neval "$4"\n');
    chmodSync(unset, 0o755);
    try {
      assert.equal(await shellClaudeConfigDir(shell, dir, {}), "/from/rc");
      assert.equal(await shellClaudeConfigDir(unset, dir, {}), "");
      await assert.rejects(shellClaudeConfigDir(join(dir, "missing"), dir, {}));
      const silent = join(dir, "silentsh");
      writeFileSync(silent, "#!/bin/sh\nexit 0\n");
      chmodSync(silent, 0o755);
      await assert.rejects(shellClaudeConfigDir(silent, dir, {}), /did not report/);
      const hung = join(dir, "hungsh");
      // Keep the late successful answer, but wait in the shell itself. A sleep
      // subprocess kept stdout open after execFile killed its parent, adding 2 s.
      writeFileSync(hung, "#!/bin/bash\nwhile (( SECONDS < 2 )); do :; done\necho aya-claude-config-dir:/late\n");
      chmodSync(hung, 0o755);
      await assert.rejects(shellClaudeConfigDir(hung, dir, {}, 200));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shellClaudeConfigDir takes the last marker line: an rc file may print one of its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aya-claude-shell-"));
    const shell = join(dir, "decoysh");
    writeFileSync(shell, '#!/bin/sh\necho "aya-claude-config-dir:/decoy"\nexport CLAUDE_CONFIG_DIR=/real\neval "$4"\n');
    chmodSync(shell, 0o755);
    try {
      assert.equal(await shellClaudeConfigDir(shell, dir, {}), "/real");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shellClaudeConfigDir gives up on a shell that hangs after about 10 seconds", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "aya-claude-shell-"));
    const shell = join(dir, "hangsh");
    writeFileSync(shell, "#!/bin/sh\nexec sleep 40\n");
    chmodSync(shell, 0o755);
    // Keep the real hung child and kill signal. Verify the app's default at the
    // execFile boundary, then scale only Node's timer and advance elapsed time
    // by that requested duration. The separate 200 ms override case above
    // exercises the actual timeout without the scaled clock.
    const realNow = Date.now;
    let clockOffset = 0;
    t.mock.method(Date, "now", () => realNow() + clockOffset);
    const require = createRequire(import.meta.url);
    const moduleId = require.resolve("../dist-electron/claude-session.js");
    const cached = require.cache[moduleId];
    const realExecFile = childProcess.execFile;
    const realExecFileAsync = promisify(realExecFile);
    const probeCalls = [];
    let nativeFailure;
    const scaledExecFile = (...args) => realExecFile(...args);
    scaledExecFile[promisify.custom] = async (file, args, options) => {
      probeCalls.push(options);
      const duration = options.timeout;
      if (!(duration > 0)) throw new Error("unbounded shell probe");
      const nativeStarted = realNow();
      try {
        return await realExecFileAsync(file, args, { ...options, timeout: Math.min(duration, 200) });
      } catch (error) {
        nativeFailure = error;
        throw error;
      } finally {
        // Only this native timer is scaled. Time spent elsewhere in the app
        // still counts, so an extra delay before/after the timeout fails too.
        clockOffset += duration - (realNow() - nativeStarted);
      }
    };
    // The module captures promisify(execFile) at load. Reload just this pure
    // module synchronously, restore both caches/exports before any await, and
    // leave the other cases' already-imported probe instances alone.
    let shellClaudeConfigDir;
    childProcess.execFile = scaledExecFile;
    delete require.cache[moduleId];
    try {
      ({ shellClaudeConfigDir } = require(moduleId));
    } finally {
      childProcess.execFile = realExecFile;
      require.cache[moduleId] = cached;
    }
    const started = Date.now();
    try {
      await assert.rejects(shellClaudeConfigDir(shell, dir, {}));
      assert.equal(probeCalls[0].timeout, 10_000, "the default is passed to Node unchanged");
      assert.equal(nativeFailure?.killed, true, "the real hung child was killed by the timer");
      const took = Date.now() - started;
      assert.ok(took >= 9_000 && took < 20_000, `took ${took} ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

test("withLiveClaudeResume: a shell that fails keeps the resume (the id cannot be proven unused) and reports why", async () => {
  const errors = [];
  const command = "claude --resume 11111111-1111-4111-8111-111111111111";
  const out = await withLiveClaudeResume(command, undefined, "/p", async () => { throw new Error("no shell"); }, (err) => errors.push(err.message));
  assert.equal(out, command);
  assert.deepEqual(errors, ["no shell"]);
  const quiet = await withLiveClaudeResume(command, undefined, "/p", async () => "", (err) => errors.push(err.message));
  assert.equal(quiet, command.replace("--resume", "--session-id"));
  assert.deepEqual(errors, ["no shell"]);
});

const file = (over) => JSON.stringify({ pid: 9, sessionId: ID, cwd: "/pane", startedAt: 100_000, procStart: "x", ...over });

test("watchClaudeSession: a file claude writes late (after the trust screen) is still picked up", async () => {
  const dir = configDir({});
  mkdirSync(join(dir, "projects", "-pane"), { recursive: true });
  writeFileSync(join(dir, "projects", "-pane", `${ID}.jsonl`), "{}\n");
  const seen = [];
  const stop = watchClaudeSession(dir, 9, (s) => seen.push(s), 10, "/pane");
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(seen, [], "not learned yet is not a guess");
    writeFileSync(join(dir, "sessions", "9.json"), file({}));
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(seen.length >= 1 && seen.every((s) => s === ID));
});
