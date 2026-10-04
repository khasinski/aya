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
const dialog = { answer: true, asked: [], holdMs: 0, closed: null, answered: null };
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  openProject: () => {},
  listProjects: async () => [],
  machines: {
    ayaHome,
    userHome: home,
    origin: "cli",
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
  rmSync(join(ayaHome, "ssh-hosts.json"), { force: true });
  rmSync(join(ayaHome, "ssh-hosts-history.jsonl"), { force: true });
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
  assert.match(r.stderr, /no answer from Aya after 1 s; nothing was added, Aya closed its dialog/);
  await answered;
  assert.equal(dialog.closed, true, "Aya closed the dialog when the caller left");
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => statSync(registryFile), /ENOENT/, "a late Add registers nothing");
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
      { id: "athena", label: "athena", reach: { ssh: "athena" }, ollama: { port: 11434 } },
      { id: "local", label: "local", reach: "local", ollama: { port: ollamaPort } },
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

test("hosts: aliases from ~/.ssh/config with their sources, the added ones marked, the wildcard left out", async () => {
  reset();
  await aya("add", "athena");
  const r = await aya("hosts");
  assert.equal(r.status, 0, r.stderr);
  // The added host is saved by the add and listed first; mini is only in ~/.ssh/config.
  assert.match(
    r.stdout,
    /^athena  ssh-config, machine, saved  \(added\)\n {8}used by: machine athena\n {8}added \d\d:\d\d from aya machines\n {8}\d\d:\d\d added as machine athena from aya machines\nmini    ssh-config\n {8}used by: nothing in Aya now\n {8}not saved: listed until it is used\n$/,
  );
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
    text: [/^athena {2}connected {4}ssh:athena {2}GPU 0% 5\.1\/24\.0 GB {2}CPU 0\.1\/32 {2}mem 10\.9\/30\.0 GB$/m, /gemma-best:latest \(f18b0e2\) hot until /, /probe \d+ ms \(checked /],
    json: { reachable: true, error: null, cpus: 32, ollama: { up: true, version: "0.34.4" } },
  },
  {
    name: "unreachable: the ssh error and when it was checked",
    mode: "down",
    text: [/^athena {2}unreachable {2}ssh:athena {2}ssh: connect to host athena port 22: Operation timed out \(checked \d\d:\d\d:\d\d\)$/m],
    json: { reachable: false, error: "ssh: connect to host athena port 22: Operation timed out", ollama: { up: false } },
  },
];
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

test("the local machine: Ollama read over HTTP on its port, no ssh", async () => {
  reset();
  await aya("add", `local port ${ollamaPort}`);
  const r = await aya();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^local {2}connected {4}local {2}GPU /m);
  assert.match(r.stdout, /ollama 0\.34\.4 {2}no model loaded/);
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
    assert.match(r.stdout, /ollama 0\.34\.4 {2}models: unavailable \(\/api\/ps answered HTTP 500\)/);
    assert.doesNotMatch(r.stdout, /no model loaded/);
  } finally {
    half.close();
  }
});

test("Ollama not answering on the local port: the machine is connected, Ollama is down", async () => {
  reset();
  const closed = createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  await aya("add", `local port ${port}`);
  const r = await aya();
  assert.match(r.stdout, /^local {2}connected {4}local/m);
  assert.match(r.stdout, new RegExp(`ollama not answering on port ${port}`));
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

test("occupy and free: advisory, records who and when, shown in the status", async () => {
  reset();
  fake.setMode("athena", "down");
  await aya("add", "athena");
  const occupied = await aya("occupy", "athena", "run5 timed collection");
  assert.equal(occupied.status, 0, occupied.stderr);
  assert.match(occupied.stdout, /Advisory only: nothing is blocked/);
  const { occupancy } = registry().machines[0];
  assert.equal(occupancy.by, "justi");
  assert.equal(occupancy.purpose, "run5 timed collection");
  assert.ok(Math.abs(Date.parse(occupancy.since) - Date.now()) < 60_000);
  assert.match((await aya()).stdout, /occupied by justi since \d\d:\d\d:\d\d: run5 timed collection/);
  const again = await aya("occupy", "athena", "reviewer");
  assert.match(again.stdout, /replaces: run5 timed collection, by justi/);
  const freed = await aya("free", "athena");
  assert.match(freed.stdout, /athena is free \(was: reviewer, by justi\)/);
  assert.equal(registry().machines[0].occupancy, undefined);
  assert.equal((await aya("occupy", "athena")).status, 1, "a purpose is required");
});

test("remove: gone from the registry; an unknown id is refused", async () => {
  reset();
  await aya("add", "athena and mini");
  const r = await aya("remove", "athena");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(registry().machines.map((m) => m.id), ["mini"]);
  const missing = await aya("remove", "athena");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no machine "athena"/);
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
