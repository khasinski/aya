// The one ssh layer (electron/ssh.ts) and its two callers, remote projects and machines, against a fake ssh on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installFakeSsh } from "./helpers/fake-ssh.mjs";

const { runSsh, sshFailure, isSshTarget, requireSshTarget } = await import("../dist-electron/ssh.js");
const { checkRemoteHealth } = await import("../dist-electron/remote-client.js");
const { probeRemote } = await import("../dist-electron/machines-probe.js");

// Written out, not derived from SSH_OPTIONS: dropping one from the source must fail here.
const HARDENED = [
  "BatchMode=yes", "ConnectTimeout=5", "ClearAllForwardings=yes", "PermitLocalCommand=no", "ForwardAgent=no",
  "ForwardX11=no", "ControlMaster=no", "ControlPath=none", "Tunnel=no", "RequestTTY=no",
].flatMap((o) => ["-o", o]).join(" ");

function fakeSsh(t) {
  const dir = mkdtempSync(join(tmpdir(), "aya-ssh-layer-"));
  const fake = installFakeSsh(dir);
  const path = process.env.PATH;
  process.env.PATH = `${fake.bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...fake, dir, calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n") };
}

const targets = [
  ["athena", true],
  ["me@athena", true],
  ["me.name+ci@gpu-box.lan", true],
  ["203.0.113.10", true],
  ["-oProxyCommand=x", false],
  ["-v", false],
  ["-Jjump", false],
  ["me@-v", false],
  ["me@-oProxyCommand=x", false],
  ["@athena", false],
  ["a b", false],
  ["a;b", false],
  ["$(id)", false],
  ["ssh://athena", false],
  ["", false],
];
for (const [target, ok] of targets) {
  test(`target ${JSON.stringify(target)} is ${ok ? "accepted" : "refused"}`, () => {
    assert.equal(isSshTarget(target), ok);
    if (ok) assert.equal(requireSshTarget(` ${target} `), target);
    else assert.throws(() => requireSshTarget(target));
  });
}

// Both callers: same options, same order, the target after "--".
const callers = [
  { name: "remote project Check", run: (target) => checkRemoteHealth(target, { bridgeMs: 2_000, sshKillMs: 3_000 }), tail: (target) => `-- ${target} node -e` },
  { name: "machine probe", run: (target) => probeRemote(target, 11434), tail: (target) => `-- ${target} sh -s` },
];
for (const c of callers) {
  for (const target of ["athena", "me@athena"]) {
    test(`${c.name} to ${target}: the hardened options, then -- and the target`, async (t) => {
      const fake = fakeSsh(t);
      fake.setMode(target, "down");
      await c.run(target);
      const [call] = fake.calls();
      assert.ok(call.startsWith(`${HARDENED} ${c.tail(target)}`), call);
    });
  }
  test(`${c.name} refuses an option-looking target before running ssh`, async (t) => {
    const fake = fakeSsh(t);
    const r = await c.run("-oProxyCommand=touch /tmp/x").catch((err) => ({ error: err.message }));
    assert.match(JSON.stringify(r), /is not an ssh target/);
    assert.equal(existsSync(join(fake.dir, "calls")), false);
  });
}

// One classification: ssh's own failures by its last stderr line, a hang by the deadline.
const failures = [
  { name: "connect timeout (255)", run: { code: 255, stderr: "ssh: connect to host athena port 22: Operation timed out\n", timedOut: false, spawnError: null }, expect: "ssh: connect to host athena port 22: Operation timed out" },
  { name: "auth (255, no ssh: prefix)", run: { code: 255, stderr: "debug\nathena: Permission denied (publickey).\n", timedOut: false, spawnError: null }, expect: "ssh: athena: Permission denied (publickey)." },
  { name: "255 with nothing said", run: { code: 255, stderr: "", timedOut: false, spawnError: null }, expect: "ssh athena exited with 255" },
  { name: "deadline", run: { code: null, stderr: "", timedOut: true, spawnError: null }, expect: "ssh athena did not finish within 1.5s." },
  { name: "no ssh binary", run: { code: null, stderr: "", timedOut: false, spawnError: "spawn ssh ENOENT" }, expect: "ssh could not be started: spawn ssh ENOENT" },
  { name: "remote command failed (1)", run: { code: 1, stderr: "sh: nope\n", timedOut: false, spawnError: null }, expect: null },
  { name: "ok (0)", run: { code: 0, stderr: "", timedOut: false, spawnError: null }, expect: null },
];
for (const f of failures) {
  test(`sshFailure: ${f.name}`, () => {
    assert.equal(sshFailure({ stdout: "", ...f.run }, "athena", 1_500), f.expect);
  });
}

test("runSsh at the deadline kills ssh's whole process group, a ProxyCommand-like child included", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-ssh-group-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\nsleep 30 &\necho $! > "${dir}/child"\nwait\n`);
  chmodSync(join(dir, "ssh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => (process.env.PATH = path));
  const started = Date.now();
  const r = await runSsh("athena", ["true"], { deadlineMs: 500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 2_500);
  const child = Number(readFileSync(join(dir, "child"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(child, 0), /ESRCH/, "the child died with the group");
});
