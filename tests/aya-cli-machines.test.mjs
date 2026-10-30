// aya machines end to end: the real CLI, the real control server on a tmp socket, a temp AYA_HOME and HOME,
// a fake ssh on PATH and a fake Ollama for the local machine. No test reaches a real host or a real Ollama.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";
import { installFakeSsh } from "./helpers/fake-ssh.mjs";
import { isolateHome } from "./helpers/isolate-home.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-machines-"));
isolateHome(root);
const ayaHome = process.env.AYA_HOME;
const home = process.env.HOME;
const fake = installFakeSsh(join(root, "ssh"));
process.env.PATH = `${fake.bin}:${process.env.PATH}`;

const { startControlServerOn } = await import("../dist-electron/control.js");
const { clearMachineStatusCache } = await import("../dist-electron/machines.js");
const { formatMachines } = await import("../dist-electron/machines.js");

const cli = resolve("bin/aya");
const registryFile = join(ayaHome, "machines.json");
const linuxFixture = resolve("tests/fixtures/machines/linux-rtx4090.probe.txt");

mkdirSync(join(home, ".ssh"), { recursive: true });
writeFileSync(join(home, ".ssh", "config"), "Host athena\n  HostName 10.0.0.5\nHost mini\nHost *\n  ServerAliveInterval 30\n");

const ollama = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/version") return res.end('{"version":"0.34.4"}');
  if (req.url === "/api/ps") return res.end('{"models":[]}');
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
const ollamaPort = ollama.address().port;

const socket = join(root, "aya.sock");
// Stands in for Aya's Add / Cancel dialog: records what the user was shown and answers `dialog.answer`,
// after `dialog.holdMs` or once Aya closes it (`dialog.closed`), as the user clicking late would.
const dialog = { answer: true, asked: [], holdMs: 0, closed: null, answered: null, removeAsked: [], removeAnswer: true, configureAsked: [], configureAnswer: true };
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  openProject: () => {},
  listProjects: async () => [],
  machines: {
    ayaHome,
    userHome: home,
    confirmRemove: async (id, signal) => {
      dialog.removeAsked.push(id);
      if (dialog.holdMs) {
        await new Promise((r) => {
          const timer = setTimeout(r, dialog.holdMs);
          signal?.addEventListener("abort", () => (clearTimeout(timer), r()));
        });
      }
      const answer = dialog.removeAnswer ?? true;
      dialog.answered?.();
      return answer;
    },
    confirmConfigure: async (ask) => {
      dialog.configureAsked.push(ask);
      return dialog.configureAnswer;
    },
    confirmAdd: async (ask, signal) => {
      dialog.asked.push(ask);
      if (dialog.holdMs) {
        await new Promise((r) => {
          const timer = setTimeout(r, dialog.holdMs);
          signal?.addEventListener("abort", () => (clearTimeout(timer), r()));
        });
      }
      dialog.closed = signal?.aborted ?? false;
      const answer = dialog.answer;
      dialog.answered?.();
      return answer;
    },
  },
});
test.after(() => {
  stop();
  ollama.close();
  rmSync(root, { recursive: true, force: true });
});

function aya(...args) {
  return ayaWith({}, ...args);
}

function ayaWith(env, ...args) {
  return new Promise((done, fail) => {
    const child = spawn(cli, ["machines", ...args], { env: { ...envWithoutAya(), AYA_SOCKET: socket, USER: "justi", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const registry = () => JSON.parse(readFileSync(registryFile, "utf8"));
const reset = () => {
  dialog.answer = true;
  dialog.asked = [];
  dialog.holdMs = 0;
  dialog.closed = null;
  dialog.answered = null;
  rmSync(registryFile, { force: true });
  rmSync(join(root, "ssh", "calls"), { force: true });
  clearMachineStatusCache();
};

test("no machines: says how to add one", async () => {
  reset();
  const r = await aya();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no machines yet/);
});

const sentenceAnswers = [
  { answer: true, out: /added athena {2}ssh:athena {2}ollama port 11434\n$/, saved: ["athena"] },
  { answer: false, out: /Not added: cancelled in Aya\.\n$/, saved: null },
];
for (const c of sentenceAnswers) {
  test(`add a sentence: the draft is probed and shown in Aya's dialog, which says ${c.answer ? "Add" : "Cancel"}`, async () => {
    reset();
    fake.setMode("athena", `ok:${linuxFixture}`);
    dialog.answer = c.answer;
    const r = await aya("add", "athena is the 4090 box, port 11434, and the laptop");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Draft:\n {2}athena {2}ssh:athena {2}ollama port 11434/);
    assert.match(r.stdout, /Did you mean this machine by "laptop"\?/);
    assert.match(r.stdout, c.out);
    assert.equal(dialog.asked.length, 1);
    assert.equal(dialog.asked[0].machines[0].status.gpus[0].name, "NVIDIA GeForce RTX 4090", "the dialog shows the probe");
    if (c.saved) assert.deepEqual(registry().machines.map((m) => m.id), c.saved);
    else assert.throws(() => statSync(registryFile), /ENOENT/);
  });
}

test("the CLI gives up before the user clicks Add: Aya closes the dialog, nothing is added, the CLI says so", async () => {
  reset();
  fake.setMode("athena", "down");
  dialog.holdMs = 5000;
  const answered = new Promise((r) => (dialog.answered = r));
  const r = await ayaWith({ AYA_REPLY_TIMEOUT_MS: "1000" }, "add", "athena");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no answer from Aya after 1 s; nothing was added, and answering Aya's dialog now changes nothing\. Run the add again/);
  await answered;
  assert.equal(dialog.closed, true, "Aya closed the dialog when the caller left");
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => statSync(registryFile), /ENOENT/, "a late Add registers nothing");
});

test("the CLI gives up before the user clicks Remove: nothing is removed, and the CLI says so instead of 'may still be in progress'", async () => {
  reset();
  fake.setMode("athena", "down");
  assert.equal((await aya("add", "athena")).status, 0);
  dialog.holdMs = 5000;
  const answered = new Promise((r) => (dialog.answered = r));
  const r = await ayaWith({ AYA_REPLY_TIMEOUT_MS: "1000" }, "remove", "athena");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no answer from Aya after 1 s; nothing was removed, and answering Aya's dialog now changes nothing\. Run the remove again/);
  await answered;
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(registry().machines.map((m) => m.id), ["athena"], "a late Remove removes nothing");
});

test("add: only an ambiguous word drafts nothing, and an unknown host is named", async () => {
  reset();
  const r = await aya("add", "zeus is my laptop");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing to add from that sentence\./);
  assert.match(r.stdout, /zeus: no such Host in ~\/\.ssh\/config/);
  assert.match(r.stdout, /"laptop"/);
  assert.equal(dialog.asked.length, 0, "nothing to ask");
});

test("add saves a versioned registry, mode 0600; port N binds to the machine before it", async () => {
  reset();
  const r = await aya("add", `athena and local port ${ollamaPort}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(registry(), {
    version: 1,
    machines: [
      { id: "athena", reach: { ssh: "athena" }, ollama: { port: 11434 } },
      { id: "local", reach: "local", ollama: { port: ollamaPort } },
    ],
  });
  assert.equal(statSync(registryFile).mode & 0o777, 0o600);
});

// One-sentence UX: the old option form is refused with a pointer to the sentence, before any probe or dialog.
const optionForms = [["--ssh", "athena"], ["--local"], ["--ssh"], ["--local", "--id", "laptop", "--port", "11435"], ["athena", "--port", "1"]];
for (const args of optionForms) {
  test(`add ${args.join(" ")}: refused with the sentence form, nothing probed or saved`, async () => {
    reset();
    const r = await aya("add", ...args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /aya machines add takes one sentence, not options: for example aya machines add "athena"/);
    assert.throws(() => statSync(registryFile), /ENOENT/);
    assert.equal(dialog.asked.length, 0, "refused before the dialog");
  });
}

// A sentence never turns an ssh option or a bare unknown address into a machine.
for (const sentence of ["-oProxyCommand=x", "203.0.113.10", "ssh -oProxyCommand=x"]) {
  test(`add "${sentence}": nothing drafted, nothing asked or saved`, async () => {
    reset();
    const r = await aya("add", sentence);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing to add from that sentence\./);
    assert.throws(() => statSync(registryFile), /ENOENT/);
    assert.equal(dialog.asked.length, 0);
  });
}

test("add \"athena port 99999\": a port out of range is not taken, Ollama's default stays", async () => {
  reset();
  const r = await aya("add", "athena port 99999");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(registry().machines.map((m) => [m.id, m.ollama.port]), [["athena", 11434]]);
});

test("hosts: aliases from ~/.ssh/config, the added ones marked, the wildcard left out", async () => {
  reset();
  await aya("add", "athena");
  const r = await aya("hosts");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "athena  ssh config  (added as athena)\nmini    ssh config\n");
  const json = JSON.parse((await aya("hosts", "--json")).stdout);
  assert.deepEqual(json, { version: 1, hosts: [{ target: "athena", sources: ["ssh config"], machine: "athena" }, { target: "mini", sources: ["ssh config"] }] });
});

test("a sentence naming an added alias says so and drafts nothing", async () => {
  reset();
  await aya("add", "athena");
  const r = await aya("add", "athena");
  assert.match(r.stdout, /athena: already added/);
  assert.doesNotMatch(r.stdout, /run:/);
});

const statusRows = [
  {
    name: "connected over ssh with a GPU and a hot model",
    mode: `ok:${linuxFixture}`,
    text: [
      /^athena {2}RTX 4090 GPU 0% VRAM 5\.1\/24\.0 GiB {2}CPU 0\.1\/32 {2}RAM 10\.9\/30\.0 GiB {2}ssh:athena\n {8}ollama 0\.34\.4\n {10}gemma-best:latest 0\.3 GiB \(reported by Ollama\) hot until /m,
      /\n {8}not claimed\nchecked \d\d:\d\d:\d\d\n$/,
    ],
    json: { reachable: true, error: null, cpus: 32, ollama: { up: true, version: "0.34.4" } },
  },
  {
    name: "unreachable: the ssh error and when it was checked",
    mode: "down",
    text: [/^athena {2}Host telemetry unavailable: ssh: connect to host athena port 22: Operation timed out\n {8}not claimed\n/m],
    json: { reachable: false, error: "ssh: connect to host athena port 22: Operation timed out", ollama: { up: false } },
  },
];

test("CLI and status-bar telemetry line share the reason and safe host-key guidance", () => {
  const output = formatMachines([{
    id: "gpu-box",
    reach: { ssh: "gpu-box" },
    ollama: { port: 11434 },
    status: {
      reachable: false, checkedAt: new Date("2026-10-30T10:00:00Z").toISOString(),
      error: "ssh: Host key verification failed.", cpuName: null, cpus: null, load1: null,
      memUsedBytes: null, memTotalBytes: null, gpus: [], gpuError: null,
      ollama: { up: false, version: null, loaded: null, modelsError: null, installed: null, running: null },
      api: { up: true, models: [], error: null },
    },
  }]);
  assert.match(output, /gpu-box  Host telemetry unavailable: ssh: Host key verification failed\. Verify the host key once in a terminal: ssh gpu-box/);
  assert.match(output, /API available \(OpenAI-compatible\)/);
});

test("CLI keeps the SSH host-key hint when its API is also down", () => {
  const output = formatMachines([{
    id: "gpu-box", reach: { ssh: "gpu-box" }, ollama: { port: 11434 },
    status: {
      reachable: false, checkedAt: new Date("2026-10-30T10:00:00Z").toISOString(),
      error: "ssh: Host key verification failed.", cpuName: null, cpus: null, load1: null,
      memUsedBytes: null, memTotalBytes: null, gpus: [], gpuError: null,
      ollama: { up: false, version: null, loaded: null, modelsError: null, installed: null, running: null },
      api: { up: false, models: null, error: "API authentication failed" },
    },
  }]);
  assert.match(output, /gpu-box  Host telemetry unavailable: ssh: Host key verification failed\. Verify the host key once in a terminal: ssh gpu-box/);
  assert.match(output, /API authentication failed/);
});
for (const row of statusRows) {
  test(`aya machines: ${row.name}`, async () => {
    reset();
    fake.setMode("athena", row.mode);
    await aya("add", "athena");
    const text = await aya();
    assert.equal(text.status, 0, text.stderr);
    for (const re of row.text) assert.match(text.stdout, re);
    clearMachineStatusCache();
    const json = await aya("--json");
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.version, 1);
    const status = doc.machines[0].status;
    for (const [k, v] of Object.entries(row.json)) {
      if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v)) assert.equal(status[k][k2], v2, `${k}.${k2}`);
      else assert.equal(status[k], v, k);
    }
    assert.ok(!Number.isNaN(Date.parse(status.checkedAt)));
  });
}

test("the local machine: the same probe through sh, Ollama read on its port, no ssh", async () => {
  reset();
  await aya("add", `local port ${ollamaPort}`);
  const r = await aya();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^local {2}.*CPU [\d.]+\/\d+ {2}RAM [\d.]+\/[\d.]+ GiB {2}local$/m);
  assert.match(r.stdout, /ollama 0\.34\.4, no model loaded/);
  assert.throws(() => readFileSync(join(root, "ssh", "calls")), /ENOENT/);
});

test("Ollama answers its version but not /api/ps: models unavailable, never \"no model loaded\"", async () => {
  reset();
  const half = createServer((req, res) => {
    if (req.url === "/api/version") return res.end('{"version":"0.34.4"}');
    res.statusCode = 500;
    res.end("boom");
  });
  await new Promise((r) => half.listen(0, "127.0.0.1", r));
  try {
    await aya("add", `local port ${half.address().port}`);
    const r = await aya();
    assert.match(r.stdout, /ollama 0\.34\.4, models unavailable \(unexpected answer from \/api\/ps\)/);
    assert.doesNotMatch(r.stdout, /no model loaded/);
  } finally {
    half.close();
  }
});

test("nothing on the local Ollama port: the machine is connected, and Ollama is named silent for this host's reason", async () => {
  reset();
  const closed = createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  await aya("add", `local port ${port}`);
  const r = await aya();
  assert.match(r.stdout, /^local {2}.* {2}local$/m);
  // Which of the three depends on this host: no ollama here (CI), installed and not running, or running on another port.
  assert.match(r.stdout, new RegExp(`\\n +ollama (not installed|not running \\(nothing on port ${port}\\)|not answering on port ${port})\\n`));
});

test("two callers at once share one probe per machine", async () => {
  reset();
  fake.setMode("athena", `ok:${linuxFixture}`);
  await aya("add", "athena");
  rmSync(join(root, "ssh", "calls"));
  const [a, b] = await Promise.all([aya("--json"), aya("--json")]);
  assert.equal(a.status + b.status, 0);
  assert.equal(readFileSync(join(root, "ssh", "calls"), "utf8").trim().split("\n").length, 1);
});

test("claim and release: advisory, records who and when, shown in the status; someone else's claim is not taken", async () => {
  reset();
  fake.setMode("athena", "down");
  await aya("add", "athena");
  const claimed = await aya("claim", "athena", "run5 timed collection");
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.match(claimed.stdout, /Advisory: nothing is blocked/);
  const { claim } = registry().machines[0];
  assert.equal(claim.by, "justi");
  assert.equal(claim.purpose, "run5 timed collection");
  assert.ok(Math.abs(Date.parse(claim.since) - Date.now()) < 60_000);
  assert.match((await aya()).stdout, /claimed by justi since \d\d:\d\d: run5 timed collection/);
  const refused = await ayaWith({ USER: "ola" }, "claim", "athena", "reviewer");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /athena is claimed by justi since \d\d:\d\d: run5 timed collection\. Not changed; ask the user, or add --replace/);
  assert.equal(registry().machines[0].claim.by, "justi");
  const taken = await ayaWith({ USER: "ola" }, "claim", "athena", "reviewer", "--replace");
  assert.match(taken.stdout, /took it over from justi: run5 timed collection/);
  const released = await aya("release", "athena");
  assert.match(released.stdout, /athena released \(was: reviewer, by ola\)/);
  assert.equal(registry().machines[0].claim, undefined);
  assert.equal((await aya("claim", "athena")).status, 1, "a purpose is required");
});

test("remove: asks in Aya, Cancel keeps it; Remove takes it out; an unknown id is refused", async () => {
  reset();
  await aya("add", "athena and mini");
  dialog.removeAsked = [];
  dialog.removeAnswer = false;
  const kept = await aya("remove", "athena");
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /Not removed: cancelled in Aya/);
  assert.deepEqual(registry().machines.map((m) => m.id), ["athena", "mini"]);
  dialog.removeAnswer = true;
  const r = await aya("remove", "athena");
  assert.deepEqual(dialog.removeAsked, ["athena", "athena"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(registry().machines.map((m) => m.id), ["mini"]);
  const missing = await aya("remove", "athena");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no machine "athena"/);
});

test("configure: asks in Aya, Cancel keeps the backend; Change saves it", async () => {
  reset();
  await aya("add", "athena");
  dialog.configureAsked = [];
  dialog.configureAnswer = false;
  const kept = await aya("configure", "athena", "ollama", "11435");
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /Not configured: cancelled in Aya/);
  assert.equal(registry().machines[0].ollama.port, 11434);
  dialog.configureAnswer = true;
  const r = await aya("configure", "athena", "ollama", "11435");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "athena configured: Ollama port 11435\n");
  assert.deepEqual(dialog.configureAsked, [
    { id: "athena", backend: "ollama", target: "11435", token: "none" },
    { id: "athena", backend: "ollama", target: "11435", token: "none" },
  ]);
  assert.equal(registry().machines[0].ollama.port, 11435);
});

test("a registry from a newer Aya is read as an error and never rewritten", async () => {
  reset();
  const newer = '{"version": 2, "machines": [], "leases": []}\n';
  writeFileSync(registryFile, newer);
  const r = await aya("add", "athena");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has version 2, this Aya reads version 1/);
  assert.equal(readFileSync(registryFile, "utf8"), newer);
});

test("there is no load or unload command", async () => {
  reset();
  for (const sub of ["unload", "load", "stop"]) {
    const r = await aya(sub, "athena");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: aya machines/);
  }
});

const hasExpect = spawnSync("sh", ["-c", "command -v expect"]).status === 0;

test("on a terminal too, the CLI never asks: only Aya's dialog adds", { skip: !hasExpect && "expect is not installed" }, async () => {
  reset();
  dialog.answer = false;
  const script = `set timeout 10; spawn ${cli} machines add local; expect eof`;
  const out = await new Promise((done, fail) => {
    const child = spawn("expect", ["-c", script], { env: { ...envWithoutAya(), AYA_SOCKET: socket, USER: "justi" } });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("error", fail);
    child.on("close", () => done(stdout));
  });
  assert.doesNotMatch(out, /\[y\/N\]/);
  assert.match(out, /Not added: cancelled in Aya\./);
  assert.equal(dialog.asked.length, 1);
  assert.throws(() => statSync(registryFile), /ENOENT/);
});
