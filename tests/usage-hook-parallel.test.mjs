// Panes ending a turn at once both pass the hook's throttle and race on the same scratch file: the real
// generated script runs N times in parallel in a fake HOME with a stub curl.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookScriptSource } from "../dist-electron/usage-hook.js";

const has = (n) => spawnSync("sh", ["-c", `command -v ${n}`], { stdio: "ignore" }).status === 0;
const skip = !has("jq") || !has("curl") ? "needs jq and curl" : false;
const RESP = JSON.stringify({
  five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00Z" },
  seven_day: { utilization: 34, resets_at: "2030-01-02T00:00:00Z" },
});

function setup({ initial, throttled }) {
  const home = mkdtempSync(join(tmpdir(), "aya-hook-par-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  // The stub sleeps so every parallel run is inside the fetch before any finishes.
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nsleep 0.4\nprintf '%s' '${RESP}'\n`);
  chmodSync(join(bin, "curl"), 0o755);
  const config = join(home, ".claude");
  mkdirSync(config);
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
  const aya = join(home, "aya");
  mkdirSync(aya);
  const out = join(aya, "usage.json");
  const hash = createHash("sha256").update(config).digest("hex");
  const account = join(aya, `usage-claude-${hash}.json`);
  if (initial) {
    writeFileSync(account, '{"old":true}');
    const t = throttled ? new Date() : new Date(Date.now() - 3600_000);
    utimesSync(account, t, t);
  }
  const script = join(home, "hook.sh");
  writeFileSync(script, hookScriptSource(out), { mode: 0o755 });
  return { home, bin, aya, out, account, script };
}

const run = (shell, e, extraEnv = {}) =>
  new Promise((resolve) => {
    const p = spawn(shell, [e.script], {
      env: { PATH: `${e.bin}:${process.env.PATH}`, HOME: e.home, ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, err }));
  });

// Only bash: the script's shebang is bash. A throttled run exits before any write, so one cell covers it.
const CELLS = [
  ...[1, 2, 20].flatMap((n) => [false, true].map((initial) => ({ n, throttled: false, initial }))),
  { n: 2, throttled: true, initial: true },
];
const shell = "/bin/bash";
for (const { n, throttled, initial } of CELLS) {
  test(`parallel hook: ${n}x ${shell} throttle=${throttled} initial=${initial}`, { skip }, async () => {
    const e = setup({ initial, throttled });
    try {
      const res = await Promise.all(Array.from({ length: n }, () => run(shell, e)));
      for (const r of res) assert.equal(r.code, 0, `hook failed: ${r.err}`);
      assert.equal(res.map((r) => r.err).join("").trim(), "");
      const doc = JSON.parse(readFileSync(e.account, "utf8"));
      if (throttled) assert.deepEqual(doc, { old: true });
      else {
        assert.equal(doc.fiveHour.pct, 12);
        assert.equal(doc.sevenDay.pct, 34);
        assert.deepEqual(JSON.parse(readFileSync(e.out, "utf8")), doc);
      }
      assert.deepEqual(readdirSync(e.aya).filter((f) => f.endsWith(".tmp")), []);
    } finally {
      rmSync(e.home, { recursive: true, force: true });
    }
  });
}

test("usage.json is never observable half-written", { skip }, async () => {
  const e = setup({ initial: false, throttled: false });
  // A slow cp: whatever path it writes to shows a prefix first, then the whole file.
  writeFileSync(join(e.bin, "cp"), `#!/bin/sh\nhead -c 10 "$1" > "$2"\nsleep 0.3\ncat "$1" > "$2"\n`);
  chmodSync(join(e.bin, "cp"), 0o755);
  try {
    let stop = false;
    const seen = [];
    const poll = (async () => {
      while (!stop) {
        try {
          JSON.parse(readFileSync(e.out, "utf8"));
        } catch (err) {
          if (err.code !== "ENOENT") seen.push(String(err.message));
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    const r = await run("/bin/bash", e);
    stop = true;
    await poll;
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(seen, []);
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});

test("a failed fetch leaves no scratch file behind", { skip }, async () => {
  const e = setup({ initial: true, throttled: false });
  writeFileSync(join(e.bin, "curl"), `#!/bin/sh\nprintf 'not json'\n`);
  // A non-default config dir skips the copy to usage.json, which would otherwise consume the scratch file.
  const other = join(e.home, "other");
  mkdirSync(other);
  writeFileSync(join(other, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
  try {
    await run("/bin/bash", e, { AYA_CLAUDE_CONFIG_DIR: other });
    assert.deepEqual(readdirSync(e.aya).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    rmSync(e.home, { recursive: true, force: true });
  }
});
