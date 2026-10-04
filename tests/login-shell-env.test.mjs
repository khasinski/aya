// The login-shell environment, which process.env cannot know (rc files run after Aya starts): one probe per app
// session, again after a failure, shared by the calls made while it runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distinctShells } from "./helpers/cli-shells.mjs";

const { parseEnvProbe, loginShellEnv, forgetLoginShellEnv, LOGIN_ENV_TIMEOUT } = await import("../dist-electron/pane-brief.js");

// Fixture scripts already run in /bin/sh: eval executes the same probe command
// and exported env without starting a second shell. Real-shell cases stay below.
async function withShell(body, run) {
  const dir = mkdtempSync(join(tmpdir(), "aya-loginenv-"));
  const shell = join(dir, "fakesh");
  const runs = join(dir, "runs");
  writeFileSync(shell, `#!/bin/sh\necho x >> '${runs}'\n${body}\n`);
  chmodSync(shell, 0o755);
  const saved = { SHELL: process.env.SHELL, ms: LOGIN_ENV_TIMEOUT.ms };
  process.env.SHELL = shell;
  forgetLoginShellEnv();
  const count = () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    await run({ count, script: (next) => writeFileSync(shell, `#!/bin/sh\necho x >> '${runs}'\n${next}\n`) });
  } finally {
    LOGIN_ENV_TIMEOUT.ms = saved.ms;
    if (saved.SHELL === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved.SHELL;
    forgetLoginShellEnv();
  }
}

test("the probe output: the env between the markers, or null when the shell did not answer", () => {
  const env = (...entries) => `banner__AYA_ENV_BEGIN__${entries.join("\0")}\0__AYA_ENV_END__tail`;
  assert.deepEqual(parseEnvProbe(env("A=1", "AYA_X=/x.json", "B=a=b")), { A: "1", AYA_X: "/x.json", B: "a=b" });
  assert.deepEqual(parseEnvProbe(env("A=1", "EMPTY=")), { A: "1", EMPTY: "" });
  assert.equal(parseEnvProbe("shell failed"), null);
  assert.equal(parseEnvProbe("__AYA_ENV_BEGIN____AYA_ENV_END__"), null, "an env that printed nothing did not answer");
  assert.equal(parseEnvProbe("__AYA_ENV_BEGIN__A=1\0B=2"), null, "a shell killed mid-env did not answer");
});

test("a variable the rc file exports is read, once per app session for every name", async () => {
  await withShell('export AYA_TEST_PROBE=from-rc\neval "$3"', async ({ count }) => {
    assert.equal((await loginShellEnv()).AYA_TEST_PROBE, "from-rc");
    assert.equal((await loginShellEnv()).AYA_TEST_UNSET, undefined);
    assert.equal(count(), 1);
  });
});

test("a shell that fails is unknown, and asked again on the next call", async () => {
  await withShell("exit 1", async ({ count, script }) => {
    assert.equal(await loginShellEnv(), null);
    assert.equal(count(), 1);
    script('export AYA_LATER=yes\neval "$3"');
    assert.equal((await loginShellEnv()).AYA_LATER, "yes", "the next call asks again and learns it");
    assert.equal(count(), 2);
  });
});

test("a shell slower than the wait is unknown; calls made meanwhile share one probe", async () => {
  await withShell('sleep 1\nexport AYA_SLOW=late\neval "$3"', async ({ count, script }) => {
    LOGIN_ENV_TIMEOUT.ms = 200;
    assert.deepEqual(await Promise.all([loginShellEnv(), loginShellEnv(), loginShellEnv()]), [null, null, null]);
    assert.ok(count() <= 1, "one shell for the three calls (it may be killed before it logs)");
    LOGIN_ENV_TIMEOUT.ms = 5000;
    script('sleep 0.3\nexport AYA_SLOW=late\neval "$3"');
    assert.equal((await loginShellEnv()).AYA_SLOW, "late");
  });
});

for (const shell of distinctShells(["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/tcsh"])) {
  test(`${shell}: values, also a multi-line one, come from the shell's environment`, async () => {
    const tag = shell.split("/").pop();
    const home = mkdtempSync(join(tmpdir(), "aya-shellhome-"));
    writeFileSync(join(home, ".login"), `setenv AYA_LOGIN_${tag} from-login\n`);
    const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
    Object.assign(process.env, { SHELL: shell, HOME: home, [`AYA_PLAIN_${tag}`]: "x y", [`AYA_ML_${tag}`]: "a\nb" });
    forgetLoginShellEnv();
    try {
      const env = await loginShellEnv();
      assert.equal(env[`AYA_PLAIN_${tag}`], "x y");
      assert.equal(env[`AYA_ML_${tag}`], "a\nb");
      assert.equal(env[`AYA_MISSING_${tag}`], undefined);
      if (tag === "tcsh") assert.equal(env[`AYA_LOGIN_${tag}`], "from-login", "still a login shell");
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      delete process.env[`AYA_PLAIN_${tag}`];
      delete process.env[`AYA_ML_${tag}`];
      forgetLoginShellEnv();
    }
  });
}
