// Interactive Codex runs agent commands in a shared `codex app-server daemon`
// that keeps the env of the pane that started it, so a later pane's `aya` calls
// carried another pane's AYA_TERMINAL_ID (measured on codex-cli 0.158.0).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitFor } from "./helpers/wait-for.mjs";
import { NON_TUI, codexSupportsNoDaemon, noDaemonCommand, withNoDaemon } from "../dist-electron/codex-daemon.js";

// Cache, quoting and binary-selection cases need the shell protocol, not a
// machine's /etc/profile. This stand-in checks the exact login-shell argv and
// executes its command with the given env. The rc and login-PATH cases below
// keep the real shells, where startup files are the behavior under test.
const probeDir = mkdtempSync(path.join(tmpdir(), "codex-probe-sh-"));
const PROBE_SHELL = path.join(probeDir, "sh");
writeFileSync(PROBE_SHELL, '#!/bin/sh\n[ "$#" -eq 4 ] && [ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ] || exit 2\neval "$4"\n', { mode: 0o755 });
test.after(() => rmSync(probeDir, { recursive: true, force: true }));

// Each probe owns its install, HOME, cwd and log. Two concurrent cases overlap
// independent probes while bounding shell pressure on the full suite.
describe("Codex daemon policy with isolated installs", { concurrency: 2 }, () => {
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
    ["codex fix the login bug", "codex --no-daemon fix the login bug"],
    ["codex write a review", "codex --no-daemon write a review"],
    ["codex act as a reviewer", "codex --no-daemon act as a reviewer"],
    ["codex -m o3 explain e and exec", "codex --no-daemon -m o3 explain e and exec"],
    ["codex -c model=o3 exec 'x'", "codex -c model=o3 exec 'x'"],
    ["codex -s read-only exec", "codex -s read-only exec"],
    ["codex -a never exec", "codex -a never exec"],
    ["/opt/bin/codex", "/opt/bin/codex --no-daemon"],
    ["  codex  ", "codex --no-daemon"],
    ["codex --no-daemon", "codex --no-daemon"],
    ["codex resume --no-daemon --last", "codex resume --no-daemon --last"],
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

  function fakeCodex(help, bin = mkdtempSync(path.join(tmpdir(), "codex-bin-"))) {
    const log = path.join(bin, "calls.log");
    writeFileSync(path.join(bin, "codex"), `#!/bin/sh\necho "$*" >> '${log}'\nwhile IFS= read -r line; do printf '%s\\n' "$line"; done <<'EOF'\n${help}\nEOF\n`);
    chmodSync(path.join(bin, "codex"), 0o755);
    return { bin, log, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin } };
  }

  const calls = (fake) => readFileSync(fake.log, "utf8").split("\n").filter(Boolean).length;

  test("codexSupportsNoDaemon reads codex --help through the shell once per installed file", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    const neu = fakeCodex("Options:\n      --no-daemon\n          Run without the shared background server");
    const old = fakeCodex("Options:\n  -m, --model <MODEL>");
    const oldFile = path.join(old.bin, "codex");
    const SAME_MTIME = 1_000_000_000;
    utimesSync(oldFile, SAME_MTIME, SAME_MTIME);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, old.env, oldFile), false);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, old.env, oldFile), false);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, old.env, "codex"), false);
    assert.equal(calls(old), 1);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, neu.env, "codex"), true);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, neu.env, "codex"), true);
    assert.equal(calls(neu), 1);
    fakeCodex("Options:\n      --no-daemon   (upgraded)", old.bin);
    utimesSync(oldFile, SAME_MTIME, SAME_MTIME);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, old.env, "codex"), true, "same mtime, new size");
    assert.equal(calls(old), 2);
  });

  test("a codex path with a space, ';' or '$(...)' reaches the probe as one word, never as shell code", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    const bin = path.join(mkdtempSync(path.join(tmpdir(), "codex odd-")), "x;touch semi;$(touch subst)");
    mkdirSync(bin);
    const fake = fakeCodex("      --no-daemon", bin);
    // Not on PATH: macOS path_helper evals PATH in /etc/profile, which would run it before the probe does.
    const env = { ...fake.env, PATH: "/usr/bin:/bin" };
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, env, path.join(bin, "codex")), true);
    assert.equal(calls(fake), 1);
    assert.deepEqual(readdirSync(cwd), [], "nothing in the path ran");
  });

  test("two installs named codex on different PATHs each get their own answer", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    const neu = fakeCodex("      --no-daemon");
    const old = fakeCodex("  -m, --model <MODEL>");
    const notRunnable = mkdtempSync(path.join(tmpdir(), "codex-noexec-"));
    writeFileSync(path.join(notRunnable, "codex"), "not a program");
    const behind = (fake) => ({ ...fake.env, PATH: `${notRunnable}:${fake.env.PATH}` });
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, behind(neu), "codex"), true);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, behind(old), "codex"), false);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, behind(neu), "codex"), true);
  });

  test("a codex only the login shell finds is asked every time", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    const hidden = fakeCodex("  -m, --model <MODEL>");
    const home = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    writeFileSync(path.join(home, ".profile"), `PATH='${hidden.bin}':$PATH\nexport PATH\n`);
    const env = { PATH: "/usr/bin:/bin", HOME: home };
    assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, env, "codex"), false);
    assert.equal(await codexSupportsNoDaemon("/bin/sh", cwd, env, "codex"), false);
    assert.equal(calls(hidden), 2);
  });

  test("codexSupportsNoDaemon: a missing codex is a no, not a throw", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, { PATH: "/usr/bin:/bin" }, "/nonexistent/codex"), false);
  });

  // --no-daemon, the wrapper rule, agentProgram (agent-session.ts) and launch mode must agree on "the program is
  // codex", or a pane gets one rewrite and not the other. [spelling, gets --no-daemon]
  const CODEX_SPELLINGS = [
    ...["codex", "/opt/bin/codex", "/opt/homebrew/bin/codex", "./codex", "../bin/codex", "~/bin/codex", "$HOME/bin/codex", "FOO=1 codex",
      'CODEX_HOME="/a b" codex', "CODEX_HOME='/a b' codex", "codex resume abc", "exec codex", "FOO=1 exec codex resume abc", "exec  /opt/bin/codex"].map((c) => [c, true]),
    ...["exec codex exec hi", "codex exec hello", "env codex", '"/opt/bin/codex"', "'codex'", "codex-cli", "mycodex", "/opt/codex/run",
      "bash -c codex", "sudo codex", "ssh host codex", "claude", "opencode --continue"].map((c) => [c, false]),
  ];

  test("--no-daemon goes onto exactly the spellings the wrapper rule, agentProgram and launch mode call codex itself", async () => {
    const { agentProgram, launchesAgentDirectly } = await import("../dist-electron/agent-session.js");
    const { launchMode } = await import("../dist-electron/launch-mode.js");
    const config = { codex: [], codexProfile: null, codexProject: [], codexTrusted: false, opencode: [], claude: [] };
    for (const [command, rewritten] of CODEX_SPELLINGS) {
      assert.equal(withNoDaemon(command) !== command, rewritten, command);
      if (!rewritten) continue;
      assert.equal(launchesAgentDirectly(command), true, command);
      assert.equal(agentProgram(command), "codex", command);
      assert.equal(launchMode(withNoDaemon(command), config).cli, "codex", `${command}: launch mode reads it as codex`);
    }
    assert.equal(withNoDaemon("FOO=1 exec codex resume abc"), "FOO=1 exec codex --no-daemon resume abc");
  });

  test("a probe that times out adds the flag, is not cached, and is asked again", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    const fake = fakeCodex("");
    const ready = path.join(fake.bin, "ready");
    // The same file throughout, so the cache key cannot change between the asks.
    writeFileSync(path.join(fake.bin, "codex"), `#!/bin/sh\necho x >> '${fake.log}'\n[ -f '${ready}' ] || sleep 4\necho '  -m, --model'\n`);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, fake.env, "codex", 700), true, "unknown: the flag wins, as identity matters more");
    writeFileSync(ready, "");
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, fake.env, "codex"), false, "a real answer after the timeout");
    // Not "2 calls": on a loaded machine the first probe can be killed before its script ran. The later asks have
    // the default timeout, and the real answer proves the second ask ran again instead of reading a cached guess.
    const asked = calls(fake);
    assert.ok(asked >= 1, "the second ask ran the probe");
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, fake.env, "codex"), false);
    assert.equal(calls(fake), asked, "a real answer is cached");
  });

  test("a probe that printed nothing and failed is not cached as a no", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    const fake = fakeCodex("");
    const ready = path.join(fake.bin, "ready");
    writeFileSync(path.join(fake.bin, "codex"), `#!/bin/sh\nif [ -f '${ready}' ]; then echo '      --no-daemon'; else exit 3; fi\n`);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, fake.env, "codex"), false);
    writeFileSync(ready, "");
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, fake.env, "codex"), true);
  });

  // A login shell's rc can block: SIGTERM to the shell does not end `sleep`, and an rc that
  // reads stdin never ends. The probe must return on its own timer and leave nothing behind.
  const RC_CASES = [
    ["sleep", (pids) => `echo $$ > '${pids}'\nsleep 7 &\necho $! >> '${pids}'\nwait\n`, "timeout"],
    ["stdin read", (pids) => `echo $$ > '${pids}'\nread x\n`, "eof"],
  ];
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  for (const shell of ["/bin/bash", "/bin/zsh"].filter((s) => existsSync(s))) {
    for (const [name, rc, ends] of RC_CASES) {
      test(`the probe is bounded by its timeout when ${shell}'s rc blocks (${name})`, async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
        const fake = fakeCodex("      --no-daemon");
        const pids = path.join(fake.bin, "rc.pids");
        for (const f of [".bash_profile", ".zshrc"]) writeFileSync(path.join(fake.bin, f), rc(pids));
        const started = Date.now();
        const answer = await codexSupportsNoDaemon(shell, cwd, { ...fake.env, ZDOTDIR: fake.bin }, "codex", ends === "timeout" ? 600 : 5000);
        const took = Date.now() - started;
        assert.equal(answer, true, "a timeout adds the flag; a closed stdin ends the read and codex answers");
        assert.ok(took < (ends === "timeout" ? 2500 : 4000), `returned after ${took} ms`);
        // Only an rc that blocks on its own keeps codex from running; a closed stdin does not.
        assert.equal(existsSync(fake.log), ends === "eof", ends === "eof" ? "codex ran after the read ended" : "codex never ran");
        const ownedPids = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
        try {
          await waitFor(() => ownedPids.every((pid) => !alive(pid)), 300, 10);
          for (const pid of ownedPids) assert.equal(alive(pid), false, `pid ${pid} is gone`);
        } finally {
          // Only the shell and sleep recorded by this case's rc, including on mutant failure.
          for (const pid of ownedPids) if (alive(pid)) process.kill(pid, "SIGKILL");
        }
      });
    }
  }

  for (const spelling of ["~/codex", "$HOME/codex", '"$HOME/codex"', "${HOME}/codex"]) {
    test(`a preset path ${spelling} is expanded with the pane's HOME before it is probed`, async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
      const fake = fakeCodex("      --no-daemon");
      const env = { PATH: "/usr/bin:/bin", HOME: fake.bin };
      assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, env, spelling), true);
      assert.equal(calls(fake), 1, "codex --help ran");
      assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, env, spelling), true);
      assert.equal(calls(fake), 1, "the install is keyed by its expanded path");
    });
  }

  for (const command of ["codex -c 'a b' --no-daemon", "codex -c \"a b\" --no-daemon resume", "codex 'fix it' --no-daemon", "codex -m 'x y' --no-daemon"]) {
    test(`${command} already has the flag: never a second one (codex rejects a duplicate)`, async () => {
      assert.equal(withNoDaemon(command), command);
      assert.equal(await noDaemonCommand(command, async () => true), command);
    });
  }

  test("a quoted option value does not hide the subcommand", () => {
    assert.equal(withNoDaemon("codex -c 'a b' exec hi"), "codex -c 'a b' exec hi");
    assert.equal(withNoDaemon("codex -c 'a b' resume"), "codex --no-daemon -c 'a b' resume");
  });

  test("the probe runs the install the preset names, not the first codex on PATH, and runs it in the pane's cwd", async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "codex-cwd-")));
    const onPath = fakeCodex("  -m, --model <MODEL>");
    const named = fakeCodex("      --no-daemon");
    writeFileSync(path.join(named.bin, "codex"), `#!/bin/sh\npwd >> '${named.log}'\necho '      --no-daemon'\n`);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, onPath.env, path.join(named.bin, "codex")), true);
    assert.equal(existsSync(onPath.log), false, "the codex on PATH was not asked");
    assert.equal(readFileSync(named.log, "utf8").trim(), cwd);
  });

  test("the cache key is the file, its mtime and its size: any one differing asks again", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-cwd-"));
    const MTIME = 1_000_000_000;
    const install = (help, mtime) => {
      const fake = fakeCodex(help);
      utimesSync(path.join(fake.bin, "codex"), mtime, mtime);
      return fake;
    };
    // Same size, same mtime, different answer: only the path tells the installs apart.
    const yes = install("      --no-daemon", MTIME);
    const no = install("      --no-dameon", MTIME);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, yes.env, "codex"), true);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, no.env, "codex"), false);
    // Same file, same size, new mtime: asked again.
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, yes.env, "codex"), true);
    assert.equal(calls(yes), 1);
    utimesSync(path.join(yes.bin, "codex"), MTIME + 5, MTIME + 5);
    assert.equal(await codexSupportsNoDaemon(PROBE_SHELL, cwd, yes.env, "codex"), true);
    assert.equal(calls(yes), 2, "a touched file is asked again");
  });

  for (const command of ["codex fix the --no-daemon flag", "codex --profile x --no-daemon", "codex -c a=b resume --last --no-daemon"]) {
    test(`${command}: a bare --no-daemon word is the flag, never added twice`, () => {
      assert.equal(withNoDaemon(command), command);
    });
  }

  // Written out, not read from NON_TUI: a subcommand dropped from the set must fail here.
  const NON_TUI_SUBCOMMANDS = [
    "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app",
    "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "queue", "archive", "delete",
    "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help", "agents",
  ];

  test("every non-TUI subcommand is left alone, bare and after option values", () => {
    assert.deepEqual([...NON_TUI].sort(), [...NON_TUI_SUBCOMMANDS].sort());
    for (const sub of NON_TUI_SUBCOMMANDS) {
      assert.equal(withNoDaemon(`codex ${sub}`), `codex ${sub}`, sub);
      assert.equal(withNoDaemon(`codex -m gpt-5 -c a=b ${sub} x`), `codex -m gpt-5 -c a=b ${sub} x`, sub);
    }
  });
});
