// Interactive Codex runs agent commands in a shared `codex app-server daemon`
// that keeps the env of the pane that started it, so a later pane's `aya` calls
// carried another pane's AYA_TERMINAL_ID (measured on codex-cli 0.158.0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexSupportsNoDaemon, noDaemonCommand, withNoDaemon } from "../dist-electron/codex-daemon.js";

const SPAWN_TABLE = [
  ["codex", "codex --no-daemon"],
  ["codex -a never -s read-only", "codex --no-daemon -a never -s read-only"],
  ["CODEX_HOME=~/.codex-work codex", "CODEX_HOME=~/.codex-work codex --no-daemon"],
  ["CODEX_HOME='/a b' codex resume --last", "CODEX_HOME='/a b' codex --no-daemon resume --last"],
  ["codex resume --last", "codex --no-daemon resume --last"],
  ["codex resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "codex --no-daemon resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"],
  ["codex fork --last", "codex --no-daemon fork --last"],
  ['codex "review the diff"', 'codex --no-daemon "review the diff"'],
  ["codex 'fix the login bug'", "codex --no-daemon 'fix the login bug'"],
  ["codex resume --last 'explain exec and --no-daemon'", "codex --no-daemon resume --last 'explain exec and --no-daemon'"],
  ["codex -m gpt-5 exec", "codex -m gpt-5 exec"],
  ["codex --profile review", "codex --no-daemon --profile review"],
  ["codex -p review resume --last", "codex --no-daemon -p review resume --last"],
  ["codex -c model=o3 -m exec", "codex --no-daemon -c model=o3 -m exec"],
  ["codex -s read-only -a never -C login", "codex --no-daemon -s read-only -a never -C login"],
  ["codex --enable apply --disable review --add-dir app --local-provider cloud", "codex --no-daemon --enable apply --disable review --add-dir app --local-provider cloud"],
  ["codex --remote e --remote-auth-token-env a -i delete", "codex --no-daemon --remote e --remote-auth-token-env a -i delete"],
  ["codex --config=x exec", "codex --config=x exec"],
  ["codex --profile=review", "codex --no-daemon --profile=review"],
  ["codex -p work review", "codex -p work review"],
  ["codex --search exec", "codex --search exec"],
  ["codex -c model=o3 exec 'x'", "codex -c model=o3 exec 'x'"],
  ["codex -s read-only exec", "codex -s read-only exec"],
  ["codex -a never exec", "codex -a never exec"],
  ["/opt/bin/codex", "/opt/bin/codex --no-daemon"],
  ["  codex  ", "codex --no-daemon"],
  ["codex --no-daemon", "codex --no-daemon"],
  ["codex resume --no-daemon --last", "codex resume --no-daemon --last"],
  ["codex exec 'run tests'", "codex exec 'run tests'"],
  ["codex e 'run tests'", "codex e 'run tests'"],
  ["codex -m gpt-5 exec 'x'", "codex -m gpt-5 exec 'x'"],
  ["codex review", "codex review"],
  ["codex login", "codex login"],
  ["codex app-server", "codex app-server"],
  ["claude --continue", "claude --continue"],
  ["codexx", "codexx"],
  ["echo codex", "echo codex"],
];

for (const [command, expected] of SPAWN_TABLE) {
  test(`withNoDaemon: ${JSON.stringify(command)} -> ${JSON.stringify(expected)}`, () => {
    assert.equal(withNoDaemon(command), expected);
  });
}

test("noDaemonCommand adds the flag only when the installed codex has it, and asks only for codex TUI commands", async () => {
  const asked = [];
  const assignments = [];
  const supports = (answer) => async (binary, words) => {
    asked.push(binary);
    assignments.push(words);
    return answer;
  };
  assert.equal(await noDaemonCommand("CODEX_HOME=/x PATH=/y codex resume --last", supports(true)), "CODEX_HOME=/x PATH=/y codex --no-daemon resume --last");
  assert.equal(await noDaemonCommand("codex resume --last", supports(false)), "codex resume --last");
  assert.deepEqual(asked, ["codex", "codex"]);
  assert.deepEqual(assignments, [["CODEX_HOME=/x", "PATH=/y"], []]);
  assert.equal(await noDaemonCommand("codex exec x", supports(true)), "codex exec x");
  assert.equal(await noDaemonCommand("codex --no-daemon", supports(true)), "codex --no-daemon");
  assert.equal(await noDaemonCommand("claude", supports(true)), "claude");
  assert.equal(await noDaemonCommand("/opt/bin/codex", supports(true)), "/opt/bin/codex --no-daemon");
  assert.deepEqual(asked, ["codex", "codex", "/opt/bin/codex"]);
});

test("noDaemonCommand keeps the command when the probe fails or throws before it starts", async () => {
  const out = await noDaemonCommand("codex", async () => {
    throw new Error("probe timed out");
  });
  assert.equal(out, "codex");
  const early = await noDaemonCommand("X=$(date) codex", () => {
    throw new Error("unsupported shell expansion");
  });
  assert.equal(early, "X=$(date) codex");
});

function fakeCodex(help) {
  const bin = mkdtempSync(path.join(tmpdir(), "codex-bin-"));
  const log = path.join(bin, "calls.log");
  writeFileSync(path.join(bin, "codex"), `#!/bin/sh\necho "$*" >> '${log}'\ncat <<'EOF'\n${help}\nEOF\n`);
  chmodSync(path.join(bin, "codex"), 0o755);
  return { bin, log, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin } };
}

test("codexSupportsNoDaemon reads codex --help through the shell, caching only a yes", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
  const neu = fakeCodex("Options:\n      --no-daemon\n          Run without the shared background server");
  const old = fakeCodex("Options:\n  -m, --model <MODEL>");
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, old.env, path.join(old.bin, "codex")), false);
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, old.env, path.join(old.bin, "codex")), false);
  assert.equal((await import("node:fs")).readFileSync(old.log, "utf8"), "--help\n--help\n");
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, neu.env, "codex"), true);
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, neu.env, "codex"), true);
  assert.equal((await import("node:fs")).readFileSync(neu.log, "utf8"), "--help\n");
});

test("two installs named codex on different PATHs each get their own answer", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
  const neu = fakeCodex("      --no-daemon");
  const old = fakeCodex("  -m, --model <MODEL>");
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, neu.env, "codex"), true);
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, old.env, "codex"), false);
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, neu.env, "codex"), true);
});

test("codexSupportsNoDaemon: a missing codex is a no, not a throw", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
  assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, { PATH: "/usr/bin:/bin" }, "/nonexistent/codex"), false);
});
