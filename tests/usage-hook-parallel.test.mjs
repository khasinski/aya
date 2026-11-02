// The generated statusLine script, run for real: it snapshots `rate_limits` from stdin in Aya's file shape, passes
// the input on to the user's previous statusLine command, and never fails the status line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookScriptSource } from "../dist-electron/usage-hook.js";

const skip = spawnSync("sh", ["-c", "command -v jq"], { stdio: "ignore" }).status === 0 ? false : "needs jq";
const INPUT = JSON.stringify({
  model: { id: "m" },
  rate_limits: {
    five_hour: { used_percentage: 12.5, resets_at: 1893456000 },
    seven_day: { used_percentage: 34, resets_at: 1893542400 },
  },
});

function setup({ old } = {}) {
  const home = mkdtempSync(join(tmpdir(), "aya-sl-"));
  const config = join(home, ".claude");
  mkdirSync(config);
  const aya = join(home, "aya");
  mkdirSync(aya);
  const out = join(aya, "usage.json");
  const account = join(aya, `usage-claude-${createHash("sha256").update(config).digest("hex")}.json`);
  if (old !== undefined) {
    writeFileSync(account, '{"old":true}');
    const t = new Date(Date.now() - old * 1000);
    utimesSync(account, t, t);
  }
  const script = join(home, "sl.sh");
  writeFileSync(script, hookScriptSource(out), { mode: 0o755 });
  return { home, aya, out, account, script };
}

const run = (e, input = INPUT, extraEnv = {}) =>
  new Promise((resolve) => {
    const p = spawn("/bin/bash", [e.script], {
      env: { PATH: process.env.PATH, HOME: e.home, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(input);
  });
const tmps = (e) => readdirSync(e.aya).filter((f) => f.endsWith(".tmp"));

test("snapshots both windows (epoch resets become ISO) for the default account and usage.json", { skip }, async () => {
  const e = setup();
  try {
    const r = await run(e);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(readFileSync(e.account, "utf8"));
    assert.equal(doc.fiveHour.pct, 12.5);
    assert.equal(doc.fiveHour.resetsAt, "2030-01-01T00:00:00Z");
    assert.equal(doc.sevenDay.pct, 34);
    assert.match(doc.updatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(JSON.parse(readFileSync(e.out, "utf8")), doc);
    assert.deepEqual(tmps(e), []);
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});

test("a window without a figure is omitted, not written as null", { skip }, async () => {
  const e = setup();
  try {
    await run(e, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 4, resets_at: 1893542400 } } }));
    const doc = JSON.parse(readFileSync(e.account, "utf8"));
    assert.equal("fiveHour" in doc, false);
    assert.equal(doc.sevenDay.pct, 4);
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});

test("input without rate_limits, or garbage, writes nothing and still succeeds", { skip }, async () => {
  const e = setup({ old: 3600 });
  try {
    for (const input of [JSON.stringify({ model: {} }), "not json", ""]) {
      const r = await run(e, input);
      assert.equal(r.code, 0, r.stderr);
    }
    assert.deepEqual(JSON.parse(readFileSync(e.account, "utf8")), { old: true });
    assert.deepEqual(tmps(e), []);
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});

test("a snapshot written within the throttle is left alone; an older one is replaced", { skip }, async () => {
  const fresh = setup({ old: 1 });
  const stale = setup({ old: 3600 });
  try {
    await run(fresh);
    await run(stale);
    assert.deepEqual(JSON.parse(readFileSync(fresh.account, "utf8")), { old: true });
    assert.equal(JSON.parse(readFileSync(stale.account, "utf8")).fiveHour.pct, 12.5);
  } finally {
    rmSync(fresh.home, { recursive: true, force: true });
    rmSync(stale.home, { recursive: true, force: true });
  }
});

test("a non-default config dir writes only its own file", { skip }, async () => {
  const e = setup();
  const other = join(e.home, "other");
  mkdirSync(other);
  try {
    await run(e, INPUT, { AYA_CLAUDE_CONFIG_DIR: other });
    const own = join(e.aya, `usage-claude-${createHash("sha256").update(other).digest("hex")}.json`);
    assert.equal(JSON.parse(readFileSync(own, "utf8")).sevenDay.pct, 34);
    assert.deepEqual(readdirSync(e.aya).filter((f) => f === "usage.json"), []);
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});

test("the user's previous statusLine gets the same input and its output and status pass through", { skip }, async () => {
  const e = setup();
  try {
    const next = Buffer.from("cat > /dev/null; echo my-line; exit 3").toString("base64");
    const r = await run(e, INPUT, { AYA_STATUSLINE_NEXT_B64: next });
    assert.equal(r.stdout, "my-line\n");
    assert.equal(r.code, 3);
    const echo = Buffer.from("jq -r .model.id").toString("base64");
    assert.equal((await run(e, INPUT, { AYA_STATUSLINE_NEXT_B64: echo })).stdout.trim(), "m");
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});

test("without a previous statusLine it prints nothing", { skip }, async () => {
  const e = setup();
  try {
    const r = await run(e);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});

test("parallel runs (several panes) leave one valid file and no scratch files", { skip }, async () => {
  const e = setup();
  try {
    const res = await Promise.all(Array.from({ length: 20 }, () => run(e)));
    for (const r of res) assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(e.account, "utf8")).sevenDay.pct, 34);
    assert.deepEqual(JSON.parse(readFileSync(e.out, "utf8")), JSON.parse(readFileSync(e.account, "utf8")));
    assert.deepEqual(tmps(e), []);
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});
