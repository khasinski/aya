// Aya and Aya Dev (same HOME) edit ~/.claude/settings.json from two processes, which no in-process queue orders:
// each read-modify-write must keep the other instance's hooks, and a dead or stale lock must not block them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolateHome } from "./helpers/isolate-home.mjs";
import { STALE_LOCK_MS } from "../dist-electron/keyed-queue.js";

const root = mkdtempSync(join(tmpdir(), "aya-settings-two-instances-"));
isolateHome(root);
const settingsPath = join(root, "settings.json");
const dist = resolve("dist-electron");
test.after(() => rmSync(root, { recursive: true, force: true }));

const OPS = {
  "status install": "status.installStatusHook()",
  "usage install": "usage.installUsageHook()",
};
// Each instance's own script path in settings.json after its op ran.
const MARK = { "status install": "aya-status-hook.sh", "usage install": "aya-usage-hook.sh" };

/** One Aya instance as its own process: waits for `at`, then runs `op` once. */
function instance(name, op, at) {
  const ayaHome = join(root, name);
  mkdirSync(ayaHome, { recursive: true });
  const code = `
    const status = await import(${JSON.stringify(join(dist, "status-hook.js"))});
    const usage = await import(${JSON.stringify(join(dist, "usage-hook.js"))});
    while (Date.now() < ${at}) await new Promise((r) => setTimeout(r, 1));
    await ${OPS[op]};`;
  const env = { ...process.env, HOME: join(root, "home"), AYA_HOME: ayaHome, AYA_CLAUDE_SETTINGS: settingsPath };
  for (const key of ["AYA_SOCKET", "AYA_TERMINAL_ID", "AYA_PROJECT_SLUG", "AYA_PRESET_ID", "AYA_DEV"]) delete env[key];
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  return new Promise((done, fail) => child.on("exit", (c) => (c === 0 ? done() : fail(new Error(`${name} ${op} exit ${c}: ${err}`)))));
}

const PAIRS = [
  ["status install", "status install"],
  ["status install", "usage install"],
  ["usage install", "status install"],
];
const RUNS = 6;

for (const [a, b] of PAIRS) {
  test(`Aya: ${a}, Aya Dev: ${b} at the same moment -> both instances' hooks stay in settings.json (${RUNS} runs)`, { timeout: 60_000 }, async () => {
    const lost = [];
    for (let run = 0; run < RUNS; run++) {
      writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/mine.sh" }] }] } }));
      const at = Date.now() + 400;
      await Promise.all([instance(`a${run}`, a, at), instance(`b${run}`, b, at)]);
      const text = readFileSync(settingsPath, "utf8");
      const missing = [
        ["Aya", `/a${run}/`, a],
        ["Aya Dev", `/b${run}/`, b],
      ].filter(([, dir, op]) => MARK[op] && !text.includes(`${dir}${MARK[op]}`));
      if (!text.includes("/mine.sh")) missing.push(["the user's own hook"]);
      if (missing.length) lost.push(`run ${run}: lost ${missing.map((m) => m[0]).join(", ")}`);
    }
    assert.deepEqual(lost, []);
  });
}

const LOCK = `${settingsPath}.aya-lock`;
const hasOwnHook = (name) => readFileSync(settingsPath, "utf8").includes(`/${name}/aya-status-hook.sh`);

test("another Aya is mid-edit (its lock is fresh, its process alive) -> install waits for it, then lands", { timeout: 15_000 }, async () => {
  writeFileSync(settingsPath, "{}");
  writeFileSync(LOCK, String(process.pid));
  const done = instance("waits", "status install", Date.now());
  await new Promise((r) => setTimeout(r, 1500));
  const whileLocked = hasOwnHook("waits");
  rmSync(LOCK);
  await done;
  assert.deepEqual([whileLocked, hasOwnHook("waits")], [false, true]);
});

const STALE = {
  "a lock left by an Aya that crashed mid-edit (its process is gone)": async () => {
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.on("exit", r));
    writeFileSync(LOCK, String(gone.pid));
  },
  "a lock older than the stale limit (its process alive)": () => {
    writeFileSync(LOCK, String(process.pid));
    const old = new Date(Date.now() - STALE_LOCK_MS - 2_000);
    utimesSync(LOCK, old, old);
  },
};
for (const [name, leave] of Object.entries(STALE)) {
  test(`${name} -> install takes it over at once and leaves no lock behind`, { timeout: 15_000 }, async () => {
    writeFileSync(settingsPath, "{}");
    await leave();
    const started = Date.now();
    await instance("takes-over", "status install", started);
    assert.deepEqual([hasOwnHook("takes-over"), existsSync(LOCK), Date.now() - started < 5000], [true, false, true]);
  });
}
