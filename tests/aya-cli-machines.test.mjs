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
const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {}, listProjects: async () => [] });
test.after(() => {
  stop();
  ollama.close();
  rmSync(root, { recursive: true, force: true });
});

function aya(...args) {
  return new Promise((done, fail) => {
    const child = spawn(cli, ["machines", ...args], { env: { ...envWithoutAya(), AYA_SOCKET: socket, USER: "justi" } });
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

test("add a sentence from a non-TTY caller: prints the draft and the exact command, saves nothing", async () => {
  reset();
  const r = await aya("add", "athena is the 4090 box, port 11434, and the laptop");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Draft:\n {2}athena {2}ssh:athena {2}ollama port 11434/);
  assert.match(r.stdout, /Did you mean this machine by "laptop"\?/);
  assert.match(r.stdout, /Nothing saved\. After the user says yes, run:\n {2}aya machines add --ssh athena\n/);
  assert.throws(() => statSync(registryFile), /ENOENT/);
  const calls = (() => { try { return readFileSync(join(root, "ssh", "calls"), "utf8"); } catch { return ""; } })();
  assert.equal(calls, "", "a draft does not ssh anywhere");
});

test("add: only an ambiguous word drafts nothing, and an unknown host is named", async () => {
  reset();
  const r = await aya("add", "zeus is my laptop");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing to add from that sentence\./);
  assert.match(r.stdout, /zeus: no such Host in ~\/\.ssh\/config/);
  assert.match(r.stdout, /"laptop"/);
  assert.doesNotMatch(r.stdout, /aya machines add --/);
});

test("manual add saves a versioned registry, mode 0600; --id and --port bind to the machine before them", async () => {
  reset();
  const r = await aya("add", "--ssh", "athena", "--local", "--id", "laptop", "--port", String(ollamaPort));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(registry(), {
    version: 1,
    machines: [
      { id: "athena", label: "athena", reach: { ssh: "athena" }, ollama: { port: 11434 } },
      { id: "laptop", label: "laptop", reach: "local", ollama: { port: ollamaPort } },
    ],
  });
  assert.equal(statSync(registryFile).mode & 0o777, 0o600);
});

const manualAddRefusals = [
  { args: ["--ssh", "-oProxyCommand=x"], error: /not an ssh alias/ },
  { args: ["--port", "1"], error: /comes after --ssh/ },
  { args: ["--ssh", "a", "--port", "99999"], error: /not a port number/ },
  { args: ["--ssh", "a", "--id", "Bad_Id"], error: /may use only/ },
  { args: ["--ssh", "a", "--ssh", "b", "--id", "a"], error: /already added/ },
  { args: ["--ssh"], error: /needs a value/ },
];
for (const c of manualAddRefusals) {
  test(`manual add refused, nothing saved: ${c.args.join(" ")}`, async () => {
    reset();
    const r = await aya("add", ...c.args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, c.error);
    assert.throws(() => statSync(registryFile), /ENOENT/);
  });
}

test("hosts: aliases from ~/.ssh/config, the added ones marked, the wildcard left out", async () => {
  reset();
  await aya("add", "--ssh", "athena");
  const r = await aya("hosts");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "athena  (added)\nmini\n");
});

test("a sentence naming an added alias says so and drafts nothing", async () => {
  reset();
  await aya("add", "--ssh", "athena");
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
    await aya("add", "--ssh", "athena");
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
  await aya("add", "--local", "--id", "laptop", "--port", String(ollamaPort));
  const r = await aya();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^laptop {2}connected {4}local {2}GPU /m);
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
    await aya("add", "--local", "--port", String(half.address().port));
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
  await aya("add", "--local", "--port", String(port));
  const r = await aya();
  assert.match(r.stdout, /^local {2}connected {4}local/m);
  assert.match(r.stdout, new RegExp(`ollama not answering on port ${port}`));
});

test("two callers at once share one probe per machine", async () => {
  reset();
  fake.setMode("athena", `ok:${linuxFixture}`);
  await aya("add", "--ssh", "athena");
  const [a, b] = await Promise.all([aya("--json"), aya("--json")]);
  assert.equal(a.status + b.status, 0);
  assert.equal(readFileSync(join(root, "ssh", "calls"), "utf8").trim().split("\n").length, 1);
});

test("occupy and free: advisory, records who and when, shown in the status", async () => {
  reset();
  fake.setMode("athena", "down");
  await aya("add", "--ssh", "athena");
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
  await aya("add", "--ssh", "athena", "--ssh", "mini");
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
  const r = await aya("add", "--ssh", "athena");
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
/** The CLI on a real pseudo-terminal (expect), answering the y/N question with `answer`; async, the server runs in this process. */
function ayaOnTty(sentence, answer) {
  const script = `set timeout 10; spawn ${cli} machines add {${sentence}}; expect {\\[y/N\\] } { send "${answer}\\r" }; expect eof`;
  return new Promise((done, fail) => {
    const child = spawn("expect", ["-c", script], { env: { ...envWithoutAya(), AYA_SOCKET: socket, USER: "justi" } });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout }));
  });
}

const ttyAnswers = [
  { answer: "y", saved: [["athena", { ssh: "athena" }], ["local", "local"]], out: /added athena[\s\S]*added local/ },
  { answer: "n", saved: null, out: /Nothing saved\./ },
  { answer: "", saved: null, out: /Nothing saved\./ },
];
for (const c of ttyAnswers) {
  test(`add a sentence on a terminal asks y/N: "${c.answer}"`, { skip: !hasExpect && "expect is not installed" }, async () => {
    reset();
    const r = await ayaOnTty("athena and this machine", c.answer);
    assert.match(r.stdout, /Draft:\r?\n {2}athena {2}ssh:athena[\s\S]*Save these machines\? \[y\/N\]/);
    assert.match(r.stdout, c.out);
    if (c.saved) assert.deepEqual(registry().machines.map((m) => [m.id, m.reach]), c.saved);
    else assert.throws(() => statSync(registryFile), /ENOENT/);
  });
}
