// The status bar item and its popover: one table over the states a machine can be in, so each says what `aya machines` says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addAnswerText, barLabel, claimText, hardware, shortCpuName, health, hotText, loadText, modelLines, readyFirst, troubleText } from "../dist-test/machines-view.js";

const NOW = new Date("2026-10-04T15:00:00Z");
const GIB = 2 ** 30;
const status = (over = {}) => ({
  reachable: true,
  checkedAt: NOW.toISOString(),
  error: null,
  cpuName: "AMD Ryzen 9 7950X",
  cpus: 32,
  load1: 3.2,
  memUsedBytes: 41 * GIB,
  memTotalBytes: 125 * GIB,
  gpus: [{ name: "NVIDIA GeForce RTX 4090", utilPct: 97, memUsedMiB: 21504, memTotalMiB: 24576 }],
  ollama: { up: true, version: "0.12.3", loaded: [{ name: "qwen3:32b", vramBytes: 19.2 * GIB, expiresAt: "2026-10-04T15:14:30Z", pinned: false }], modelsError: null },
  ...over,
});
const view = (s, over = {}) => ({ id: "athena", reach: { ssh: "athena" }, ollama: { port: 11434 }, status: s, ...over });
const shown = (s) => ({ health: health(s).word, level: health(s).level, hw: hardware(s), load: loadText(s), models: modelLines(s, NOW) });

const mac = { cpuName: "Apple M2 Max", cpus: 12, load1: 4.5, memUsedBytes: 30 * GIB, memTotalBytes: 64 * GIB, gpus: [] };
const CASES = [
  ["busy GPU, model hot", status(), { health: "Ready", level: "ok", hw: "RTX 4090", load: "GPU 97% · VRAM 21.0/24.0 GB", models: ["qwen3:32b · 19.2 GB · until 15:14 (14 min)"].map((l) => l.replace("15:14", new Date("2026-10-04T15:14:30Z").toTimeString().slice(0, 5))) }],
  ["a Mac: its chip, CPU and RAM instead of a GPU", status({ ...mac, ollama: { up: true, version: "0.12.3", loaded: [], modelsError: null } }), { health: "Ready", level: "ok", hw: "Apple M2 Max", load: "load 4.5 on 12 CPUs · RAM 30.0/64.0 GB", models: ["No model loaded"] }],
  ["Ollama installed, not running", status({ ...mac, ollama: { up: false, version: null, loaded: null, modelsError: null, installed: true, running: false } }), { health: "Ollama not running", level: "warn", hw: "Apple M2 Max", load: "load 4.5 on 12 CPUs · RAM 30.0/64.0 GB", models: [] }],
  ["no Ollama on the host", status({ ...mac, ollama: { up: false, version: null, loaded: null, modelsError: null, installed: false, running: false } }), { health: "Ollama not installed", level: "warn", hw: "Apple M2 Max", load: "load 4.5 on 12 CPUs · RAM 30.0/64.0 GB", models: [] }],
  ["Ollama runs but its port is silent", status({ ...mac, ollama: { up: false, version: null, loaded: null, modelsError: null, installed: true, running: true } }), { health: "Ollama not answering", level: "warn", hw: "Apple M2 Max", load: "load 4.5 on 12 CPUs · RAM 30.0/64.0 GB", models: [] }],
  ["models list unavailable: never \"no model loaded\"", status({ ollama: { up: true, version: "0.12.3", loaded: null, modelsError: "no answer from /api/ps" } }), { health: "Ready", level: "ok", hw: "RTX 4090", load: "GPU 97% · VRAM 21.0/24.0 GB", models: ["Models unavailable (no answer from /api/ps)"] }],
  ["two GPUs, a pinned model", status({ gpus: [{ name: "NVIDIA RTX A6000", utilPct: 10, memUsedMiB: 1024, memTotalMiB: 8192 }, { name: "NVIDIA RTX A6000", utilPct: 60, memUsedMiB: 2048, memTotalMiB: 8192 }], ollama: { up: true, version: "1", loaded: [{ name: "m1", vramBytes: null, expiresAt: null, pinned: true }], modelsError: null } }), { health: "Ready", level: "ok", hw: "RTX A6000 + RTX A6000", load: "GPU 60% · VRAM 3.0/16.0 GB", models: ["m1 · pinned"] }],
  ["unreachable", status({ reachable: false, error: "ssh: Permission denied", cpuName: null, cpus: null, load1: null, memUsedBytes: null, memTotalBytes: null, gpus: [], ollama: { up: false, version: null, loaded: null, modelsError: null } }), { health: "Unreachable", level: "down", hw: "", load: "load ? on ? CPUs · RAM ?/? GB", models: [] }],
];
for (const [name, s, want] of CASES) test(`shown: ${name}`, () => assert.deepEqual(shown(s), want));

test("hot time: whole minutes left, never rounded up; pinned and expired named", () => {
  const at = (min) => new Date(NOW.getTime() + min * 60_000).toISOString();
  const left = (min) => hotText(at(min), false, NOW).replace(/^until \d\d:\d\d /, "");
  assert.deepEqual([left(14.9), left(90.5), left(0.2), hotText(at(-2), false, NOW), hotText(null, true, NOW), hotText(null, false, NOW)], ["(14 min)", "(90 min)", "(0 min)", "expired", "pinned", "loaded"]);
});

test("a claim says what for, who, which pane and since when; its age once it is an hour old", () => {
  const claim = { by: "justi", pane: "lead", purpose: "run5 timed collection", since: "2026-10-04T14:20:00Z" };
  const since = new Date(claim.since).toTimeString().slice(0, 5);
  assert.equal(claimText(claim, NOW), `run5 timed collection · justi (pane lead) · since ${since}`);
  assert.equal(claimText({ ...claim, pane: undefined }, new Date("2026-10-04T21:30:00Z")), `run5 timed collection · justi · since ${since} (7 h ago)`);
});

test("the status bar button names every machine's state in words", () => {
  const down = status({ reachable: false, error: "x", gpus: [] });
  const claim = { by: "u", purpose: "p", since: NOW.toISOString() };
  assert.equal(barLabel([view(status(), { claim }), view(down, { id: "mini" })]), "Machines: athena ready, claimed; mini unreachable");
});

test("the add answer in Settings is a sentence, not the CLI's draft", () => {
  const cases = [
    ["Draft:\n  local  local  ollama port 11434\nadded local  local  ollama port 11434\n", "Added local."],
    ["Draft:\n  a  ssh:a  ollama port 11434\n  b  ssh:b  ollama port 11434\nadded a  ssh:a  ollama port 11434\nadded b  ssh:b  ollama port 11434\n", "Added a and b."],
    ["Draft:\n  local  local  ollama port 11434\nNot added: cancelled in Aya.\n", "Not added: cancelled in Aya."],
    ["Nothing to add from that sentence.\n  zzz: no such Host in ~/.ssh/config and no known host (aya machines hosts lists them)\n", "Nothing to add from that sentence. zzz: no such host in ~/.ssh/config and no known host."],
    ["Draft:\n  m  ssh:m  ollama port 11434\n  athena: already added\n  Did you mean this machine by \"laptop\"? Say local to add it, or name its ssh alias.\nadded m  ssh:m  ollama port 11434\n", 'Added m. athena is already added. Did you mean this machine by "laptop"? Say local to add it, or name its ssh alias.'],
    ["Nothing to add from that sentence.\n  this machine: already added\n", "Nothing to add from that sentence. this machine is already added."],
  ];
  for (const [output, text] of cases) assert.equal(addAnswerText(output), text);
});

test("a broken NVIDIA driver is its own state, with nvidia-smi's words; the CPU names the machine", () => {
  const s = status({ ...mac, gpuError: "Failed to initialize NVML: Driver/library version mismatch" });
  assert.deepEqual(health(s), { word: "GPU error", level: "warn" });
  assert.equal(hardware(s), "Apple M2 Max");
  assert.equal(troubleText(s), "GPU error: Driver/library version mismatch");
  assert.match(barLabel([view(s)]), /athena gpu error/);
  // A silent Ollama outranks it: with no Ollama, the GPU does not matter yet.
  assert.equal(health({ ...s, ollama: { up: false, version: null, loaded: null, modelsError: null, installed: true, running: false } }).word, "Ollama not running");
});

test("a CPU is named by its model: no (R), vendor, clock or core count; Apple keeps its name", () => {
  assert.equal(shortCpuName("Intel(R) Xeon(R) CPU E3-1245 V2 @ 3.40GHz"), "Xeon E3-1245 V2");
  assert.equal(shortCpuName("AMD Ryzen 9 9950X3D 16-Core Processor"), "Ryzen 9 9950X3D");
  assert.equal(shortCpuName("Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz"), "Core i7-8700K");
  assert.equal(shortCpuName("Apple M5 Max"), "Apple M5 Max");
});

test("a machine in trouble is one line: its state and the reason's last clause", () => {
  assert.equal(troubleText(status({ reachable: false, error: "ssh: connect to host 192.168.0.65 port 22: Operation timed out" })), "Unreachable: Operation timed out");
  assert.equal(troubleText(status({ reachable: false, error: "the probe did not finish within 10s." })), "Unreachable: the probe did not finish within 10s.");
  assert.equal(troubleText(status({ ...mac, ollama: { up: false, version: null, loaded: null, modelsError: null, installed: false, running: false } })), "Ollama not installed");
});

test("ready machines come first, then the least broken; the user's order within each", () => {
  const v = (id, s) => ({ id, status: s });
  const down = status({ reachable: false, error: "x" });
  const noOllama = status({ ollama: { up: false, version: null, loaded: null, modelsError: null, installed: true, running: false } });
  const gpuError = status({ ...mac, gpuError: "Failed to initialize NVML: Driver/library version mismatch" });
  const order = readyFirst([v("desktop", down), v("macbook", noOllama), v("darwine", gpuError), v("local", status()), v("athena", down), v("lab", status())]);
  assert.deepEqual(order.map((x) => x.id), ["local", "lab", "darwine", "macbook", "desktop", "athena"]);
});
