// aya machines probes: recorded probe outputs (a Linux RTX 4090 host, this macOS laptop) parsed table-driven,
// and the ssh call itself against a fake ssh on PATH. No test reaches a real host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installFakeSsh } from "./helpers/fake-ssh.mjs";

const { parseRemoteProbe, probeRemote, remoteProbeScript, PROBE_DEADLINE_MS } = await import("../dist-electron/machines-probe.js");

const fixture = (name) => readFileSync(join("tests/fixtures/machines", name), "utf8");
const linux = fixture("linux-rtx4090.probe.txt");
const macos = fixture("macos.probe.txt");
const blank = (text, section) => text.replace(new RegExp(`(@@${section}\\n)[\\s\\S]*?(?=@@)`), "$1");
const AT = "2026-10-04T10:00:00.000Z";

const cases = [
  {
    name: "Linux /proc + nvidia-smi + Ollama with a model",
    output: linux,
    expect: {
      reachable: true, cpus: 32, load1: 0.09,
      memTotalBytes: 31481720 * 1024, memUsedBytes: (31481720 - 20098224) * 1024,
      gpus: [{ name: "NVIDIA GeForce RTX 4090", utilPct: 0, memUsedMiB: 5247, memTotalMiB: 24564 }],
      ollama: { up: true, version: "0.34.4", loaded: [{ name: "gemma-best:latest", digest: "f18b0e221a67c3b07ec8d0a98b2daef10871d6d56c998363f3e1b4f26f158db4", vramBytes: 313775881, expiresAt: "2026-10-05T04:41:31.128931058+02:00", pinned: false }] },
    },
  },
  {
    name: "macOS sysctl + vm_stat, no GPU, Ollama idle",
    output: macos,
    expect: {
      reachable: true, cpus: 10, load1: 16.61,
      memTotalBytes: 68719476736, memUsedBytes: (1791108 + 431989 + 93508) * 16384,
      gpus: [],
      ollama: { up: true, version: "0.34.4", loaded: [] },
    },
  },
  {
    name: "Linux without nvidia-smi",
    output: blank(linux, "gpu"),
    expect: { reachable: true, cpus: 32, gpus: [], ollama: { up: true } },
  },
  {
    name: "Ollama down: version and ps empty, the machine still reachable",
    output: blank(blank(linux, "version"), "ps"),
    expect: { reachable: true, cpus: 32, gpus: [{ name: "NVIDIA GeForce RTX 4090" }], ollama: { up: false, version: null, loaded: [] } },
  },
  {
    name: "a model pinned with keep_alive -1",
    output: linux.replace("2026-10-05T04:41:31.128931058+02:00", "2318-01-19T05:00:00+01:00"),
    expect: { ollama: { loaded: [{ pinned: true }] } },
  },
  {
    name: "output cut before @@end",
    output: linux.slice(0, linux.indexOf("@@ps")),
    expect: { reachable: false, error: "the probe script did not finish", cpus: null, gpus: [] },
  },
];

/** Every key in `expected` matches, recursively; arrays match element by element and in length. */
function assertShape(actual, expected, where) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${where} length`);
    expected.forEach((e, i) => assertShape(actual[i], e, `${where}[${i}]`));
  } else if (expected && typeof expected === "object") {
    for (const [k, v] of Object.entries(expected)) assertShape(actual[k], v, `${where}.${k}`);
  } else {
    assert.equal(actual, expected, where);
  }
}

for (const c of cases) {
  test(`probe parse: ${c.name}`, () => {
    const status = parseRemoteProbe(c.output, AT, 42);
    assert.equal(status.checkedAt, AT);
    assert.equal(status.probeMs, 42);
    assertShape(status, c.expect, "status");
  });
}

test("the remote script is fixed and read-only: only the port is substituted, a bad port is refused", () => {
  const script = remoteProbeScript(11434);
  assert.match(script, /http:\/\/127\.0\.0\.1:11434\/api\/ps/);
  assert.doesNotMatch(script, /keep_alive|\/api\/(generate|chat|pull|delete|create)|-X (?!GET)|--data|-d |\brm\b|>[^&/]/);
  // -q first: a remote ~/.curlrc could add a body (a keep_alive 0 unload) or a proxy. No proxy, an explicit GET.
  const curls = script.split("\n").filter((line) => line.includes("curl"));
  assert.deepEqual(curls.map((line) => line.slice(line.indexOf("curl"), line.indexOf(" 2>"))), [
    "curl -q -s --noproxy '*' -X GET --max-time 3 http://127.0.0.1:11434/api/version",
    "curl -q -s --noproxy '*' -X GET --max-time 3 http://127.0.0.1:11434/api/ps",
  ]);
  for (const bad of [0, 70000, 1.5, NaN]) assert.throws(() => remoteProbeScript(bad), /bad Ollama port/);
});

const ssh = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-ssh-"));
  const fake = installFakeSsh(dir);
  const path = process.env.PATH;
  process.env.PATH = `${fake.bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...fake, dir };
};

const remoteCases = [
  { mode: "down", expect: { reachable: false, error: "ssh: connect to host box port 22: Operation timed out" } },
  { mode: "denied", expect: { reachable: false, error: "ssh: box: Permission denied (publickey)." } },
  { mode: "unknown", expect: { reachable: false, error: /^ssh: Could not resolve hostname box/ } },
  { mode: "hang", deadlineMs: 300, expect: { reachable: false, error: "timed out after 0.3 s" } },
];

for (const c of remoteCases) {
  test(`probeRemote over a fake ssh: ${c.mode}`, async (t) => {
    const fake = ssh(t);
    fake.setMode("box", c.mode);
    const started = Date.now();
    const status = await probeRemote("box", 11434, { deadlineMs: c.deadlineMs, now: () => new Date(AT) });
    assert.equal(status.reachable, c.expect.reachable);
    assert.equal(status.checkedAt, AT);
    if (c.expect.error instanceof RegExp) assert.match(status.error, c.expect.error);
    else assert.equal(status.error, c.expect.error);
    if (c.deadlineMs) assert.ok(Date.now() - started < c.deadlineMs + 2000, "killed at the deadline");
  });
}

test("probeRemote: forwards, local commands, agent/X11 and multiplexing off whatever ~/.ssh/config says; the script on stdin", async (t) => {
  const fake = ssh(t);
  fake.setMode("athena", `ok:${join(process.cwd(), "tests/fixtures/machines/linux-rtx4090.probe.txt")}`);
  const status = await probeRemote("athena", 11434);
  assert.equal(status.reachable, true);
  assert.equal(status.gpus[0].memTotalMiB, 24564);
  assert.equal(readFileSync(join(fake.dir, "calls"), "utf8"), [
    "-o BatchMode=yes -o ConnectTimeout=5",
    "-o ClearAllForwardings=yes -o PermitLocalCommand=no -o ForwardAgent=no -o ForwardX11=no",
    "-o ControlMaster=no -o ControlPath=none -o Tunnel=no -o RequestTTY=no",
    "-- athena sh -s\n",
  ].join(" "));
  assert.equal(readFileSync(join(fake.dir, "stdin-athena"), "utf8"), remoteProbeScript(11434));
});

test("probeRemote refuses an alias that could be an ssh option or shell text, before running ssh", async (t) => {
  const fake = ssh(t);
  for (const alias of ["-oProxyCommand=x", "a b", "a;b", "", "$(id)"]) {
    await assert.rejects(probeRemote(alias, 11434), /not a valid ssh alias/);
  }
  assert.throws(() => readFileSync(join(fake.dir, "calls")), /ENOENT/);
});

test("the whole probe deadline is 10 s", () => {
  assert.equal(PROBE_DEADLINE_MS, 10_000);
});

const { localMemory, probeLocal } = await import("../dist-electron/machines-probe.js");
const meminfo = linux.slice(linux.indexOf("@@meminfo\n") + 10, linux.indexOf("@@vmstat"));
const vmStat = macos.slice(macos.indexOf("@@vmstat\n") + 9, macos.indexOf("@@memsize"));
const fakeOs = { totalmem: () => 1000, freemem: () => 100 };
const localMemoryCases = [
  // Linux: MemAvailable, as the remote path; free memory would count the page cache as used.
  { platform: "linux", sources: { meminfo }, expect: { used: (31481720 - 20098224) * 1024, total: 31481720 * 1024 } },
  { platform: "darwin", sources: { vmStat }, total: 68719476736, expect: { used: (1791108 + 431989 + 93508) * 16384, total: 68719476736 } },
  { platform: "linux", sources: {}, expect: { used: 900, total: 1000 } },
  { platform: "darwin", sources: { vmStat: "garbage" }, expect: { used: 900, total: 1000 } },
];
for (const c of localMemoryCases) {
  test(`local memory on ${c.platform} from ${Object.keys(c.sources).join(",") || "os only"}`, () => {
    const o = c.total ? { ...fakeOs, totalmem: () => c.total } : fakeOs;
    assert.deepEqual(localMemory(c.platform, c.sources, o), c.expect);
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a hung local nvidia-smi is killed with its children at the deadline, before the probe answers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-smi-"));
  const { writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "nvidia-smi"), `#!/bin/sh\necho $$ > "${dir}/pid"\nsleep 30 &\necho $! > "${dir}/child"\nwait\n`);
  chmodSync(join(dir, "bin", "nvidia-smi"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  // Long enough for a loaded machine to start the fake and write its pids.
  const status = await probeLocal(1, { deadlineMs: 3000 });
  assert.equal(status.reachable, false);
  assert.equal(status.error, "timed out after 3 s");
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  const child = Number(readFileSync(join(dir, "child"), "utf8"));
  assert.equal(alive(pid), false, "nvidia-smi was reaped before the probe answered");
  const until = Date.now() + 2000;
  while (alive(child) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(child), false, "its child died with the group");
});
