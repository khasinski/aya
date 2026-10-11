// aya machines probes: recorded probe outputs (a Linux RTX 4090 host, this macOS laptop) parsed table-driven,
// the ssh call against a fake ssh on PATH, and the same script run here through sh. No test reaches a real host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeExecutable } from "./helpers/executable.mjs";
import { installFakeSsh } from "./helpers/fake-ssh.mjs";

const { parseOllama, parseProbe, probeMachine, probeScript, PROBE_DEADLINE_MS } = await import("../dist-electron/machines-probe.js");
const probeRemote = (alias, port, options) => probeMachine({ ssh: alias }, port, options);

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
      reachable: true, cpuName: "AMD Ryzen 9 7950X 16-Core Processor", cpus: 32, load1: 0.09,
      memTotalBytes: 31481720 * 1024, memUsedBytes: (31481720 - 20098224) * 1024,
      gpus: [{ name: "NVIDIA GeForce RTX 4090", utilPct: 0, memUsedMiB: 5247, memTotalMiB: 24564 }], gpuError: null,
      ollama: { up: true, version: "0.34.4", loaded: [{ name: "gemma-best:latest", vramBytes: 313775881, expiresAt: "2026-10-05T04:41:31.128931058+02:00", pinned: false }] },
    },
  },
  {
    name: "macOS sysctl + vm_stat, no GPU, Ollama idle",
    output: macos,
    expect: {
      reachable: true, cpuName: "Apple M2 Max", cpus: 10, load1: 16.61,
      memTotalBytes: 68719476736, memUsedBytes: (1791108 + 431989 + 93508) * 16384,
      gpus: [],
      ollama: { up: true, version: "0.34.4", loaded: [], modelsError: null },
    },
  },
  {
    name: "Linux without nvidia-smi",
    output: blank(linux, "gpu"),
    expect: { reachable: true, cpus: 32, gpus: [], gpuError: null, ollama: { up: true } },
  },
  {
    // Seen on a real host: nvidia-smi prints its failure on stdout; those lines are no GPUs.
    name: "an NVIDIA driver that does not match its library: no GPU, the failure kept, the CPU named",
    output: linux.replace(/@@gpu\n[\s\S]*?(?=@@)/, "@@gpu\nFailed to initialize NVML: Driver/library version mismatch\nNVML library version: 595.99\n"),
    expect: { reachable: true, cpuName: "AMD Ryzen 9 7950X 16-Core Processor", gpus: [], gpuError: "Failed to initialize NVML: Driver/library version mismatch", ollama: { up: true } },
  },
  {
    name: "nvidia-smi with no device: no GPU and no error",
    output: linux.replace(/@@gpu\n[\s\S]*?(?=@@)/, "@@gpu\nNo devices were found\n"),
    expect: { gpus: [], gpuError: null },
  },
  {
    name: "Ollama silent: version and ps empty, the machine still reachable",
    output: blank(blank(linux, "version"), "ps"),
    expect: { reachable: true, cpus: 32, gpus: [{ name: "NVIDIA GeForce RTX 4090" }], ollama: { up: false, version: null, loaded: null } },
  },
  {
    // Under ssh's sh -s, Homebrew's ollama is found by its path, not by PATH.
    name: "Ollama installed but not running: the binary found, no process",
    output: blank(blank(linux, "version"), "ps").replace("@@version", "@@ollamabin\n/opt/homebrew/bin/ollama\n@@ollamaproc\n@@version"),
    expect: { ollama: { up: false, installed: true, running: false } },
  },
  {
    name: "no Ollama on the host: neither a binary nor a process",
    output: blank(blank(linux, "version"), "ps").replace("@@version", "@@ollamabin\n@@ollamaproc\n@@version"),
    expect: { ollama: { up: false, installed: false, running: false } },
  },
  {
    name: "an older probe without the install sections: installed and running unknown",
    output: blank(blank(linux, "version"), "ps"),
    expect: { ollama: { up: false, installed: null, running: null } },
  },
  {
    name: "Ollama answers its version but /api/ps does not: models unknown, not none",
    output: blank(linux, "ps"),
    expect: { ollama: { up: true, version: "0.34.4", loaded: null, modelsError: "no answer from /api/ps" } },
  },
  {
    name: "Ollama /api/ps answers something else than a model list: models unknown",
    output: linux.replace(/@@ps\n.*\n/, '@@ps\n{"models":{"a":1}}\n'),
    expect: { ollama: { up: true, loaded: null, modelsError: "unexpected answer from /api/ps" } },
  },
  {
    name: "Ollama /api/ps is not JSON: models unknown",
    output: linux.replace(/@@ps\n.*\n/, "@@ps\n<html>proxy error</html>\n"),
    expect: { ollama: { up: true, loaded: null, modelsError: "unexpected answer from /api/ps" } },
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
    const status = parseProbe(c.output, AT);
    assert.equal(status.checkedAt, AT);
    assertShape(status, c.expect, "status");
  });
}

test("the probe script is fixed and read-only: only the port is substituted, a bad port is refused", () => {
  const script = probeScript(11434);
  assert.match(script, /http:\/\/127\.0\.0\.1:11434\/api\/ps/);
  assert.doesNotMatch(script, /keep_alive|\/api\/(generate|chat|pull|delete|create)|-X (?!GET)|--data|-d |\brm\b|>[^&/]/);
  // -q first: a remote ~/.curlrc could add a body (a keep_alive 0 unload) or a proxy. No proxy, an explicit GET.
  const curls = script.split("\n").filter((line) => line.includes("curl"));
  assert.deepEqual(curls.map((line) => line.slice(line.indexOf("curl"), line.indexOf(" 2>"))), [
    "curl -q -s --noproxy '*' -X GET --max-time 3 http://127.0.0.1:11434/api/version",
    "curl -q -s --noproxy '*' -X GET --max-time 3 http://127.0.0.1:11434/api/ps",
  ]);
  for (const bad of [0, 70000, 1.5, NaN]) assert.throws(() => probeScript(bad), /bad Ollama port/);
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
  { mode: "hang", deadlineMs: 300, expect: { reachable: false, error: "ssh box did not finish within 0.3s." } },
];

for (const c of remoteCases) {
  test(`probe over a fake ssh: ${c.mode}`, async (t) => {
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

test("probe over ssh: forwards, local commands, agent/X11 and multiplexing off whatever ~/.ssh/config says; the script on stdin", async (t) => {
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
  assert.equal(readFileSync(join(fake.dir, "stdin-athena"), "utf8"), probeScript(11434));
});

test("the probe refuses an alias that could be an ssh option or shell text, before running ssh", async (t) => {
  const fake = ssh(t);
  for (const alias of ["-oProxyCommand=x", "a b", "a;b", "", "$(id)", "u@-oProxyCommand=x", "@host"]) {
    await assert.rejects(probeRemote(alias, 11434), /is not an ssh target|target is required/);
  }
  assert.throws(() => readFileSync(join(fake.dir, "calls")), /ENOENT/);
});

test("the whole probe deadline is 10 s", () => {
  assert.equal(PROBE_DEADLINE_MS, 10_000);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("this machine: the same script through sh, no ssh; Ollama on an unused port is down, the machine reachable", async () => {
  const status = await probeMachine("local", 1);
  assert.equal(status.reachable, true, status.error);
  assert.ok(status.cpus > 0 && status.memTotalBytes > 0, "cores and memory read");
  assert.equal(status.ollama.up, false);
});

test("a hung local nvidia-smi is killed with its children at the deadline, before the probe answers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-smi-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "bin"));
  writeExecutable(join(dir, "bin", "nvidia-smi"), `#!/bin/sh\necho $$ > "${dir}/pid"\nsleep 30 &\necho $! > "${dir}/child"\nwait\n`);
  const path = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  // Long enough for a loaded machine to start the fake and write its pids.
  const status = await probeMachine("local", 1, { deadlineMs: 3000 });
  assert.equal(status.reachable, false);
  assert.equal(status.error, "the probe did not finish within 3s.");
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  const child = Number(readFileSync(join(dir, "child"), "utf8"));
  const until = Date.now() + 2000;
  while ((alive(pid) || alive(child)) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, "nvidia-smi died with the group");
  assert.equal(alive(child), false, "its child died with the group");
});

test("an nvidia-smi that fails on stderr only is a GPU error, never a machine that looks ready without its GPU", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-smi-err-"));
  const { writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "nvidia-smi"), "#!/bin/sh\necho 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.' >&2\nexit 9\n");
  chmodSync(join(dir, "bin", "nvidia-smi"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  const status = await probeMachine("local", 1);
  assert.equal(status.reachable, true);
  assert.deepEqual(status.gpus, []);
  assert.equal(status.gpuError, "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.");
});

test("an /api/ps entry that is not an object is skipped, never a crash that hides every machine", () => {
  const o = parseOllama('{"version":"0.12.3"}', '{"models":[null, 7, [], {"name":"qwen3:32b","size_vram":1}]}');
  assert.equal(o.up, true);
  assert.deepEqual(o.loaded.map((m) => m.name), ["qwen3:32b"]);
});
