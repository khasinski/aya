// Settings > Machines row cells: one table over the states a machine can be in, so each column says the same thing as `aya machines`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gpuCell, health, hotShort, loadCell, memoryCell, modelCell, vramCell } from "../dist-test/machines-view.js";

const NOW = new Date("2026-10-04T15:00:00Z");
const GIB = 2 ** 30;
const status = (over = {}) => ({
  reachable: true,
  checkedAt: NOW.toISOString(),
  error: null,
  probeMs: 10,
  cpus: 32,
  load1: 3.2,
  memUsedBytes: 41 * GIB,
  memTotalBytes: 125 * GIB,
  gpus: [{ name: "RTX 4090", utilPct: 97, memUsedMiB: 21504, memTotalMiB: 24576 }],
  ollama: { up: true, version: "0.12.3", loaded: [{ name: "qwen3:32b", digest: null, vramBytes: null, expiresAt: "2026-10-04T15:14:00Z", pinned: false }], modelsError: null },
  ...over,
});
const row = (s) => ({
  health: health(s).word,
  level: health(s).level,
  gpu: gpuCell(s).text,
  vram: vramCell(s).text,
  load: loadCell(s).text,
  mem: memoryCell(s).text,
  model: Object.values(modelCell(s, NOW)).filter(Boolean).join(" "),
});

const CASES = [
  ["busy GPU, model hot", status(), { health: "Ready", level: "ok", gpu: "97%", vram: "21.0/24.0", load: "3.2/32", mem: "41.0/125.0", model: "qwen3:32b hot 14m" }],
  ["idle GPU, nothing loaded", status({ gpus: [{ name: "RTX 3090", utilPct: 0, memUsedMiB: 307, memTotalMiB: 24576 }], ollama: { up: true, version: "0.12.3", loaded: [], modelsError: null } }), { health: "Ready", level: "ok", gpu: "0%", vram: "0.3/24.0", load: "3.2/32", mem: "41.0/125.0", model: "none loaded" }],
  ["Ollama down, no GPU", status({ gpus: [], ollama: { up: false, version: null, loaded: null, modelsError: null } }), { health: "Ollama down", level: "warn", gpu: "none", vram: "-", load: "3.2/32", mem: "41.0/125.0", model: "-" }],
  ["models list unavailable", status({ ollama: { up: true, version: "0.12.3", loaded: null, modelsError: "timeout" } }), { health: "Ready", level: "ok", gpu: "97%", vram: "21.0/24.0", load: "3.2/32", mem: "41.0/125.0", model: "unavailable" }],
  ["two GPUs, two models", status({ gpus: [{ name: "a", utilPct: 10, memUsedMiB: 1024, memTotalMiB: 8192 }, { name: "b", utilPct: 60, memUsedMiB: 2048, memTotalMiB: 8192 }], ollama: { up: true, version: "1", loaded: [{ name: "m1", expiresAt: null, pinned: true }, { name: "m2", expiresAt: null, pinned: false }], modelsError: null } }), { health: "Ready", level: "ok", gpu: "60% x2", vram: "3.0/16.0", load: "3.2/32", mem: "41.0/125.0", model: "m1 +1 pinned" }],
  ["unreachable", status({ reachable: false, error: "Permission denied", cpus: null, load1: null, memUsedBytes: null, memTotalBytes: null, gpus: [], ollama: { up: false, version: null, loaded: null, modelsError: null } }), { health: "Unreachable", level: "down", gpu: "none", vram: "-", load: "-", mem: "-", model: "-" }],
];

for (const [name, s, want] of CASES) test(`row cells: ${name}`, () => assert.deepEqual(row(s), want));

test("hotShort: minutes under an hour, hours after, pinned and expired named", () => {
  const at = (min) => new Date(NOW.getTime() + min * 60_000).toISOString();
  assert.deepEqual(
    [hotShort(at(14), false, NOW), hotShort(at(59), false, NOW), hotShort(at(60), false, NOW), hotShort(at(150), false, NOW), hotShort(at(-2), false, NOW), hotShort(null, true, NOW), hotShort(null, false, NOW)],
    ["hot 14m", "hot 59m", "hot 1h", "hot 3h", "expired", "pinned", "loaded"],
  );
});

test("bars: a fraction of the total, clamped, none without a total", () => {
  assert.equal(gpuCell(status()).frac, 0.97);
  assert.equal(vramCell(status()).frac, 21504 / 24576);
  assert.equal(loadCell(status({ load1: 64, cpus: 32 })).frac, 1);
  assert.equal(memoryCell(status({ memTotalBytes: null })).frac, null);
});
