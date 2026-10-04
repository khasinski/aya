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
  assert.doesNotMatch(script, /keep_alive|\/api\/(generate|chat|pull|delete|create)|-X|--data|\brm\b|>[^&/]/);
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

test("probeRemote: BatchMode, ConnectTimeout 5, the alias after --, and the script on stdin", async (t) => {
  const fake = ssh(t);
  fake.setMode("athena", `ok:${join(process.cwd(), "tests/fixtures/machines/linux-rtx4090.probe.txt")}`);
  const status = await probeRemote("athena", 11434);
  assert.equal(status.reachable, true);
  assert.equal(status.gpus[0].memTotalMiB, 24564);
  assert.equal(readFileSync(join(fake.dir, "calls"), "utf8"), "-o BatchMode=yes -o ConnectTimeout=5 -- athena sh -s\n");
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
