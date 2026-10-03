// `aya debug on|off|status` and `aya team debug <team> [-f]` work with no app running.
// Table: command x state (switch off/on, a log or none, the team in one project or two) x shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";
import { waitFor } from "./helpers/wait-for.mjs";

delete process.env.AYA_DEBUG;
const debug = await import("../dist-electron/team-debug.js");
const { AYA_CAPABILITIES } = await import("../dist-electron/capabilities.js");

const cli = resolve("bin/aya");

function home() {
  const root = mkdtempSync(join(tmpdir(), "aya-cli-debug-"));
  return { root, aya: join(root, "aya"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const env = (h, extra = {}) => ({ PATH: process.env.PATH, HOME: h.root, AYA_HOME: h.aya, ...extra });
const run = (shell, h, args, extra) => spawnSync(shell, [cli, ...args], { env: env(h, extra), encoding: "utf8", timeout: 10000 });

const entry = (n, event, fields) => JSON.stringify({ time: new Date(Date.UTC(2026, 9, 2, 10, 0, n)).toISOString(), event, ...fields });

function teamLog(h, project, team, lines) {
  const dir = join(h.aya, "teams", project, team);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, debug.DEBUG_LOG_FILE), lines.map((l) => `${l}\n`).join(""));
  return join(dir, debug.DEBUG_LOG_FILE);
}

for (const shell of CLI_SHELLS) {
  const opts = shellOptions(shell);

  test(`${shell} | aya debug status|on|off: off by default, on and off in debug.json`, opts, () => {
    const h = home();
    try {
      let r = run(shell, h, ["debug", "status"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^debug is off/);
      r = run(shell, h, ["debug", "on"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(h.aya, debug.DEBUG_SWITCH_FILE), "utf8")), { on: true });
      assert.match(r.stdout, /^debug is on/);
      assert.equal(debug.readDebugSwitch(h.aya), true, "the app reads what the CLI wrote");
      assert.match(run(shell, h, ["debug", "status"]).stdout, /^debug is on/);
      r = run(shell, h, ["debug", "off"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(debug.readDebugSwitch(h.aya), false);
      assert.match(run(shell, h, ["debug", "status"]).stdout, /^debug is off/);
    } finally {
      h.cleanup();
    }
  });

  test(`${shell} | aya debug with no or another word: usage, exit 1, nothing written`, opts, () => {
    const h = home();
    try {
      for (const args of [["debug"], ["debug", "maybe"]]) {
        const r = run(shell, h, args);
        assert.equal(r.status, 1, args.join(" "));
        assert.match(r.stderr, /Usage:/);
      }
      assert.equal(debug.readDebugSwitch(h.aya), false);
    } finally {
      h.cleanup();
    }
  });

  test(`${shell} | aya team debug <team>: the last 50 entries, one readable line each`, opts, () => {
    const h = home();
    try {
      const lines = Array.from({ length: 60 }, (_, i) => entry(i % 60, "round", { round: i, reason: "rhythm", typed: true }));
      lines.push(entry(59, "hold", { to: "tester", reason: "shows an approval prompt", id: null }));
      teamLog(h, "game", "ux-review", lines);
      const r = run(shell, h, ["team", "debug", "ux-review"]);
      assert.equal(r.status, 0, r.stderr);
      const out = r.stdout.trim().split("\n");
      assert.equal(out.length, 50);
      const said = AYA_CAPABILITIES.find((c) => c.command === "team debug").summary;
      assert.ok(said.includes(`last ${out.length} debug entries`), `aya capabilities tells agents the same count: ${said}`);
      // Fields start after the longest event name, round-check (11), and one space.
      assert.match(out[0], /^\d\d:\d\d:\d\d round {7}round=11 reason=rhythm typed=true$/);
      assert.match(out.at(-1), /^\d\d:\d\d:\d\d hold {8}to=tester reason="shows an approval prompt" id=null$/);
    } finally {
      h.cleanup();
    }
  });

  test(`${shell} | aya team debug: no such team, or one in two projects (AYA_PROJECT_SLUG picks)`, opts, () => {
    const h = home();
    try {
      let r = run(shell, h, ["team", "debug", "ux-review"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /no debug log for team ux-review.*aya debug on/);
      teamLog(h, "game", "ux-review", [entry(1, "start", { started: true })]);
      teamLog(h, "chess", "ux-review", [entry(2, "pause", { by: "user" })]);
      r = run(shell, h, ["team", "debug", "ux-review"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /in more than one project \(chess, game\); set AYA_PROJECT_SLUG/);
      r = run(shell, h, ["team", "debug", "ux-review"], { AYA_PROJECT_SLUG: "chess" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /pause +by=user/);
      // Each name would reach a log: refused as a name, not as a missing team.
      teamLog(h, "x", "debug", [entry(3, "start", {})]);
      teamLog(h, "game", ".hidden", [entry(4, "start", {})]);
      for (const bad of ["../x/debug", ".hidden", ""]) {
        const refused = run(shell, h, ["team", "debug", bad]);
        assert.equal(refused.status, 1, `refuses "${bad}"`);
        assert.match(refused.stderr, /Usage:/, `refuses "${bad}" as a name`);
      }
    } finally {
      h.cleanup();
    }
  });

  // A shell starting node under load, then the reader's next poll.
  const FOLLOW_MS = 5000;
  test(`${shell} | aya team debug -f: follows new entries, and the file again after a rotation`, opts, async () => {
    const h = home();
    const file = teamLog(h, "game", "ux-review", [entry(1, "start", { started: true })]);
    const child = spawn(shell, [cli, "team", "debug", "ux-review", "-f"], { env: env(h), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    try {
      await waitFor(() => /start +started=true/.test(out), FOLLOW_MS);
      appendFileSync(file, `${entry(2, "round", { round: 1, reason: "silence" })}\n`);
      await waitFor(() => /round +round=1 reason=silence/.test(out), FOLLOW_MS);
      writeFileSync(file, `${entry(3, "liveness", { status: "stalled" })}\n`);
      await waitFor(() => /liveness +status=stalled/.test(out), FOLLOW_MS);
    } finally {
      // A reader that already exited (no log found) must fail the test, not hang it.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited;
      }
      h.cleanup();
    }
  });
}

test("aya debug on reaches a running Aya with no restart", async () => {
  const h = home();
  mkdirSync(h.aya, { recursive: true });
  const stop = debug.watchDebugSwitch(h.aya);
  try {
    assert.equal(debug.debugOn(), false);
    assert.equal(run("/bin/sh", h, ["debug", "on"]).status, 0);
    await waitFor(() => debug.debugOn() === true);
    assert.equal(run("/bin/sh", h, ["debug", "off"]).status, 0);
    await waitFor(() => debug.debugOn() === false);
  } finally {
    stop();
    h.cleanup();
  }
});
